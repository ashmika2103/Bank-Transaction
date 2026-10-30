require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const path = require('path');
const Transaction = require('./models/Transaction');
const Account = require('./models/Account');
const AuditEvent = require('./models/AuditEvent');
const app = express();
app.use(express.json({limit:'20kb'})); app.use(cookieParser());
app.use(cors({origin: process.env.CLIENT_ORIGIN || 'http://127.0.0.1:5500', credentials:true}));
app.use('/api/auth/login', rateLimit({windowMs:15*60*1000, max:8, standardHeaders:true, legacyHeaders:false}));
const auth = (req,res,next)=>{const token=req.cookies.bank_session || (req.headers.authorization||'').replace(/^Bearer /,'');try{req.user=jwt.verify(token,process.env.JWT_SECRET);next();}catch{return res.status(401).json({error:'Authentication required.'});}};
const admin = (req,res,next)=>req.user?.role==='admin'?next():res.status(403).json({error:'Administrator access required.'});
const audit = (action,detail,transactionId='')=>AuditEvent.create({action,detail,transactionId}).catch(console.error);
const safe = t => ({id:t.transactionId, transactionId:t.transactionId, type:t.type, sourceAccount:t.sourceAccount, destinationAccount:t.destinationAccount, account:t.sourceAccount&&t.destinationAccount?`${t.sourceAccount} → ${t.destinationAccount}`:(t.sourceAccount||t.destinationAccount), amount:t.amount, created:t.createdAt, lock:t.lockHeld||'—', waitsFor:t.waitsFor||'—', status:t.status});
app.get('/api/health',(req,res)=>res.json({status:'ok',database:mongoose.connection.readyState===1?'connected':'disconnected'}));
app.post('/api/auth/login',async(req,res)=>{try{const {username,password}=req.body||{};if(!username||!password)return res.status(400).json({error:'Username and password are required.'});const hash=process.env.ADMIN_PASSWORD_HASH;if(username!==process.env.ADMIN_USERNAME||!hash||!(await bcrypt.compare(password,hash)))return res.status(401).json({error:'Invalid credentials.'});const token=jwt.sign({sub:username,role:'admin'},process.env.JWT_SECRET,{expiresIn:'30m'});res.cookie('bank_session',token,{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production',maxAge:30*60*1000});res.json({message:'Signed in.'});}catch(e){res.status(500).json({error:'Unable to sign in.'});}});
app.post('/api/auth/logout',(req,res)=>res.clearCookie('bank_session',{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production'}).json({message:'Signed out.'}));
app.get('/api/auth/me',auth,(req,res)=>res.json({username:req.user.sub,role:req.user.role}));
app.get('/api/accounts',async(req,res)=>{try{res.json(await Account.find({active:true}).select('accountNumber holderName balance currency accountType').sort({accountNumber:1}).lean());}catch{res.status(500).json({error:'Could not load accounts.'});}});
app.get('/api/transactions',async(req,res)=>{try{const filter={};if(req.query.status)filter.status=req.query.status;if(req.query.type)filter.type=req.query.type;const rows=await Transaction.find(filter).sort({createdAt:-1}).limit(500).lean();res.json(rows.map(safe));}catch{res.status(500).json({error:'Could not load transactions.'});}});

const heldResources = value => String(value || '').split(',').map(x => x.trim()).filter(Boolean);

async function lockOwner(resource, exceptTransactionId = '') {
  const rows = await Transaction.find({
    transactionId: { $ne: exceptTransactionId },
    status: { $in: ['WAITING', 'ACTIVE', 'DEADLOCKED'] },
    lockHeld: { $ne: '' }
  }).select('transactionId lockHeld').lean();
  return rows.find(row => heldResources(row.lockHeld).includes(resource)) || null;
}

async function completeTransaction(transactionId) {
  const tx = await Transaction.findOne({ transactionId });
  if (!tx || tx.status !== 'ACTIVE') return;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (tx.type === 'Deposit') {
        const result = await Account.updateOne(
          { accountNumber: tx.destinationAccount, active: true },
          { $inc: { balance: tx.amount } },
          { session }
        );
        if (!result.matchedCount) throw new Error('ACCOUNT_NOT_FOUND');
      } else {
        const source = await Account.findOne({
          accountNumber: tx.sourceAccount, active: true
        }).session(session);
        if (!source) throw new Error('ACCOUNT_NOT_FOUND');
        if (source.balance < tx.amount) throw new Error('INSUFFICIENT');

        const debit = await Account.updateOne(
          { accountNumber: tx.sourceAccount, active: true, balance: { $gte: tx.amount } },
          { $inc: { balance: -tx.amount } },
          { session }
        );
        if (!debit.modifiedCount) throw new Error('INSUFFICIENT');

        if (tx.type === 'Fund Transfer' || tx.type === 'Payment') {
          const credit = await Account.updateOne(
            { accountNumber: tx.destinationAccount, active: true },
            { $inc: { balance: tx.amount } },
            { session }
          );
          if (!credit.matchedCount) throw new Error('ACCOUNT_NOT_FOUND');
        }
      }

      await Transaction.updateOne(
        { _id: tx._id, status: 'ACTIVE' },
        { $set: {
          status: 'COMPLETED', lockHeld: '', waitsFor: '',
          completedAt: new Date(), note: 'Transaction completed successfully'
        } },
        { session }
      );
    });
    await audit('Transaction completed', `${transactionId} completed successfully.`, transactionId);
  } catch (e) {
    const message = e.message === 'INSUFFICIENT' ? 'Insufficient balance at processing time'
      : e.message === 'ACCOUNT_NOT_FOUND' ? 'Account unavailable during processing'
      : 'Processing failed';
    await Transaction.updateOne(
      { transactionId, status: { $in: ['ACTIVE', 'WAITING'] } },
      { $set: { status: 'ABORTED', lockHeld: '', waitsFor: '', note: message } }
    );
    await audit('Transaction aborted', `${transactionId} was aborted: ${message}.`, transactionId);
  } finally {
    await session.endSession();
  }
  await resumeEligibleWaiters();
}

async function resumeEligibleWaiters() {
  const waiting = await Transaction.find({
    status: 'WAITING', waitsFor: { $ne: '' }
  }).sort({ createdAt: 1 });
  for (const tx of waiting) {
    const requestedLock = tx.waitsFor;
    const owner = await lockOwner(requestedLock, tx.transactionId);
    if (owner) continue;

    // If it holds no locks, retry acquisition from the beginning.
    if (!heldResources(tx.lockHeld).length) {
      tx.waitsFor = '';
      tx.note = 'Required account lock became available; retrying';
      await tx.save();
      setTimeout(() => processTransaction(tx.transactionId).catch(console.error), 50);
      continue;
    }

    tx.lockHeld = [...new Set([...heldResources(tx.lockHeld), requestedLock])].join(',');
    tx.waitsFor = '';
    tx.status = 'ACTIVE';
    tx.note = 'Resumed after required account lock became available';
    await tx.save();
    await completeTransaction(tx.transactionId);
  }
}

async function processTransaction(transactionId) {
  const tx = await Transaction.findOne({ transactionId });
  if (!tx || tx.status !== 'WAITING') return;

  const firstAccount = tx.sourceAccount || tx.destinationAccount;
  const firstResource = `ACCOUNT:${firstAccount}`;
  const firstOwner = await lockOwner(firstResource, tx.transactionId);
  if (firstOwner) {
    tx.waitsFor = firstResource;
    tx.note = `Waiting for account lock held by ${firstOwner.transactionId}`;
    await tx.save();
    return;
  }

  tx.status = 'ACTIVE';
  tx.lockHeld = firstResource;
  tx.waitsFor = '';
  tx.note = 'Holding first account lock; waiting for manual deadlock analysis';
  await tx.save();
  await audit('Lock acquired', `${transactionId} acquired ${firstResource}.`, transactionId);
  // Deliberately do not request the destination lock or complete the transfer here.
  // The user submits all concurrent transactions, then clicks Run Detection.
}

async function prepareAndDetectManually() {
  const live = await Transaction.find({ status: { $in: ['ACTIVE', 'WAITING'] } }).sort({ createdAt: 1 });

  // First, register each active transfer's destination lock request. All source
  // locks are already held, so opposite transfers can now form a circular wait.
  for (const tx of live) {
    if (tx.status !== 'ACTIVE' || !['Fund Transfer', 'Payment'].includes(tx.type) || !tx.sourceAccount || !tx.destinationAccount) continue;
    const requested = `ACCOUNT:${tx.destinationAccount}`;
    const owners = await Transaction.find({
      transactionId: { $ne: tx.transactionId },
      status: { $in: ['ACTIVE', 'WAITING', 'DEADLOCKED'] },
      lockHeld: requested
    }).select('transactionId').lean();

    if (owners.length) {
      tx.status = 'WAITING';
      tx.waitsFor = requested;
      tx.note = `Holding ${tx.lockHeld}; waiting for ${requested}`;
      await tx.save();
    } else {
      tx.lockHeld = [...new Set([...heldResources(tx.lockHeld), requested])].join(',');
      tx.waitsFor = '';
      tx.note = 'Destination lock acquired during manual analysis';
      await tx.save();
    }
  }

  const rows = await Transaction.find().sort({ createdAt: 1 }).lean();
  const result = findCycles(rows);
  if (result.cycles.length) {
    const affected = [...new Set(result.cycles.flat())];
    await Transaction.updateMany(
      { transactionId: { $in: affected }, status: { $in: ['WAITING', 'ACTIVE'] } },
      { $set: { status: 'DEADLOCKED', note: 'Deadlock identified by manual Wait-For Graph analysis' } }
    );
    await audit('Deadlock detected manually', `Detected ${result.cycles.length} circular wait cycle(s).`);
  } else {
    // No cycle: operations whose required locks are now available may finish.
    const ready = await Transaction.find({
      status: 'ACTIVE',
      type: { $in: ['Fund Transfer', 'Payment', 'Deposit', 'Withdrawal'] },
      waitsFor: ''
    }).sort({ createdAt: 1 });
    for (const tx of ready) {
      if (['Fund Transfer', 'Payment'].includes(tx.type) &&
          !heldResources(tx.lockHeld).includes(`ACCOUNT:${tx.destinationAccount}`)) continue;
      await completeTransaction(tx.transactionId);
    }
  }
  return { ...result, deadlock: result.cycles.length > 0 };
}

app.post('/api/transactions', async (req, res) => {
  try {
    const { type, sourceAccount = '', destinationAccount = '', amount } = req.body || {};
    const value = Number(amount);
    if (!['Deposit', 'Withdrawal', 'Fund Transfer', 'Payment'].includes(type) ||
        !Number.isFinite(value) || value <= 0) {
      return res.status(400).json({ error: 'Choose a transaction type and enter an amount greater than zero.' });
    }
    if (type === 'Withdrawal' && !sourceAccount) return res.status(400).json({ error: 'Select the account to withdraw from.' });
    if (type === 'Deposit' && !destinationAccount) return res.status(400).json({ error: 'Select the account to deposit into.' });
    if (['Fund Transfer', 'Payment'].includes(type) &&
        (!sourceAccount || !destinationAccount || sourceAccount === destinationAccount)) {
      return res.status(400).json({ error: 'Select different source and destination accounts.' });
    }

    const accountIds = [sourceAccount, destinationAccount].filter(Boolean);
    const accounts = await Account.find({ accountNumber: { $in: accountIds }, active: true });
    if (accounts.length !== new Set(accountIds).size) {
      return res.status(400).json({ error: 'One or more accounts do not exist or are inactive.' });
    }
    const source = accounts.find(a => a.accountNumber === sourceAccount);
    if (source && ['Withdrawal', 'Fund Transfer', 'Payment'].includes(type) && source.balance < value) {
      return res.status(400).json({ error: 'Insufficient available balance.' });
    }

    const transactionId = `TXN-${Date.now().toString().slice(-8)}-${Math.floor(Math.random() * 90 + 10)}`;
    const record = await Transaction.create({
      transactionId, type, sourceAccount, destinationAccount, amount: value,
      status: 'WAITING', lockHeld: '', waitsFor: '', note: 'Queued for account-lock processing'
    });
    await audit('Transaction submitted', `${type} request for INR ${value.toFixed(2)} entered processing.`, transactionId);

    // Start the lock manager after responding; concurrent transfers can contend for account locks.
    setTimeout(() => processTransaction(transactionId).catch(console.error), 100);
    res.status(201).json(safe(record));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Unable to submit transaction.' });
  }
});
app.delete('/api/transactions/:id',auth,admin,async(req,res)=>{try{const t=await Transaction.findOneAndDelete({transactionId:req.params.id});if(!t)return res.status(404).json({error:'Transaction not found.'});await audit('Transaction removed',`${t.transactionId} removed by administrator.`,t.transactionId);res.json({message:'Transaction removed.'});}catch{res.status(500).json({error:'Unable to remove transaction.'});}});

function findCycles(rows) {
  // Build a wait-for graph from every live transaction. A transaction may
  // hold more than one account lock, so map each resource to all its owners.
  const live = rows.filter(t => ['WAITING', 'ACTIVE', 'DEADLOCKED'].includes(t.status));
  const ownersByResource = new Map();
  for (const tx of live) {
    for (const resource of heldResources(tx.lockHeld)) {
      if (!ownersByResource.has(resource)) ownersByResource.set(resource, []);
      ownersByResource.get(resource).push(tx.transactionId);
    }
  }

  const graph = new Map();
  for (const tx of live) {
    const requested = String(tx.waitsFor || '').trim();
    if (!requested) continue;
    const owners = ownersByResource.get(requested) || [];
    graph.set(tx.transactionId, owners.filter(id => id !== tx.transactionId));
  }

  // DFS with a recursion stack; each returned cycle is a list of transaction IDs.
  const cycles = [];
  const visited = new Set();
  const stack = [];
  const inStack = new Set();
  const cycleKeys = new Set();
  function visit(node) {
    if (inStack.has(node)) {
      const index = stack.indexOf(node);
      const cycle = stack.slice(index);
      if (cycle.length > 1) {
        const key = [...cycle].sort().join('|');
        if (!cycleKeys.has(key)) { cycleKeys.add(key); cycles.push(cycle); }
      }
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    inStack.add(node);
    stack.push(node);
    for (const next of (graph.get(node) || [])) visit(next);
    stack.pop();
    inStack.delete(node);
  }
  for (const node of graph.keys()) visit(node);

  const edges = {};
  for (const [from, targets] of graph) if (targets.length) edges[from] = targets;
  return { edges, cycles };
}

app.post('/api/detection/run', async (req, res) => {
  try {
    const result = await prepareAndDetectManually();
    res.json({ ...result, transactions: (await Transaction.find().sort({ createdAt: -1 })).map(safe) });
  } catch (error) {
    console.error('Deadlock analysis failed:', error);
    res.status(500).json({ error: 'Deadlock analysis failed.' });
  }
});

app.post('/api/recovery/:id/abort', auth, admin, async (req, res) => {
  try {
    const victim = await Transaction.findOne({
      transactionId: req.params.id, status: 'DEADLOCKED'
    });
    if (!victim) return res.status(404).json({ error: 'Transaction is not in the deadlock recovery queue.' });

    const releasedLocks = heldResources(victim.lockHeld);
    victim.status = 'ABORTED';
    victim.lockHeld = '';
    victim.waitsFor = '';
    victim.note = 'Aborted by administrator to recover from deadlock';
    await victim.save();
    await audit('Deadlock recovery', `${victim.transactionId} aborted and its account locks released.`, victim.transactionId);

    // Re-evaluate the remaining deadlocked transactions. The survivor must
    // acquire its previously awaited lock and execute the balance update.
    const survivors = await Transaction.find({
      status: 'DEADLOCKED', transactionId: { $ne: victim.transactionId }
    }).sort({ createdAt: 1 });

    const resumed = [];
    for (const tx of survivors) {
      const requestedLock = tx.waitsFor;
      const owner = requestedLock ? await lockOwner(requestedLock, tx.transactionId) : null;
      if (!owner) {
        tx.lockHeld = [...new Set([...heldResources(tx.lockHeld), ...(requestedLock ? [requestedLock] : [])])].join(',');
        tx.waitsFor = '';
        tx.status = 'ACTIVE';
        tx.note = 'Resumed after deadlock victim was aborted';
        await tx.save();
        resumed.push(tx.transactionId);
        setTimeout(() => completeTransaction(tx.transactionId).catch(console.error), 100);
      } else {
        tx.status = 'WAITING';
        tx.note = `Still waiting for ${requestedLock}`;
        await tx.save();
      }
    }

    await resumeEligibleWaiters();
    res.json({
      message: 'Victim aborted and locks released. Eligible surviving transactions have resumed.',
      aborted: victim.transactionId,
      resumed,
      releasedLocks
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Recovery action failed.' });
  }
});
app.get('/api/history',async(req,res)=>{try{res.json(await AuditEvent.find().sort({createdAt:-1}).limit(200).lean());}catch{res.status(500).json({error:'Could not load history.'});}});
app.get('/api/admin/summary',auth,admin,async(req,res)=>{try{const [transactions,active,waiting,deadlocked,history]=await Promise.all([Transaction.countDocuments(),Transaction.countDocuments({status:'ACTIVE'}),Transaction.countDocuments({status:'WAITING'}),Transaction.countDocuments({status:'DEADLOCKED'}),AuditEvent.countDocuments()]);res.json({transactions,active,waiting,deadlocked,history});}catch{res.status(500).json({error:'Could not load summary.'});}});
app.post('/api/admin/seed-accounts',auth,admin,async(req,res)=>{try{const data=[['ACC-1001','Aarav Sharma',25000],['ACC-2002','Priya Nair',18000],['ACC-2103','Kavya Raman',32000],['ACC-0321','Rohan Kumar',12500],['ACC-1148','Meera Iyer',22000],['ACC-0801','Dev Patel',16000],['MERCHANT-001','Northstar Retail',0]];for(const [accountNumber,holderName,balance] of data)await Account.updateOne({accountNumber},{$setOnInsert:{accountNumber,holderName,balance}},{upsert:true});res.json({message:'Demo accounts are ready.',count:data.length});}catch{res.status(500).json({error:'Could not seed accounts.'});}});
app.post('/api/admin/deadlock-demo',auth,admin,async(req,res)=>{
  try {
    // Keep all existing user transactions. Only reset/upsert the two fixed demo rows.
    // The two rows retain their locks and wait dependencies until manual detection/recovery.
    const now = new Date();
    const demoRows = [
      { transactionId:'TXN-DEMO-9001', type:'Fund Transfer', sourceAccount:'ACC-1001', destinationAccount:'ACC-2002', amount:1000, status:'WAITING', lockHeld:'ACCOUNT:ACC-1001', waitsFor:'ACCOUNT:ACC-2002', createdAt:now, note:'Demo deadlock: holding ACC-1001 while waiting for ACC-2002' },
      { transactionId:'TXN-DEMO-9002', type:'Fund Transfer', sourceAccount:'ACC-2002', destinationAccount:'ACC-1001', amount:800, status:'WAITING', lockHeld:'ACCOUNT:ACC-2002', waitsFor:'ACCOUNT:ACC-1001', createdAt:now, note:'Demo deadlock: holding ACC-2002 while waiting for ACC-1001' }
    ];
    for (const row of demoRows) {
      const { transactionId, ...fields } = row;
      await Transaction.updateOne(
        { transactionId },
        { $set: fields, $setOnInsert: { transactionId } },
        { upsert: true }
      );
    }
    await audit('Deadlock scenario loaded','Two persistent demo transfers were loaded without deleting other transactions.');
    res.json({ message:'Deadlock test case loaded. Existing transactions were preserved.', transactions: demoRows.map(x=>x.transactionId) });
  } catch (error) {
    console.error('Could not load deadlock test case:', error);
    res.status(500).json({ error:'Could not load test scenario.' });
  }
});
app.post('/api/admin/reset-demo',auth,admin,async(req,res)=>{try{await Transaction.deleteMany({});await AuditEvent.deleteMany({});await audit('Demo reset','Transaction register and audit history reset by admin.');res.json({message:'Demo data cleared.'});}catch{res.status(500).json({error:'Could not reset demo.'});}});
app.use(express.static(path.join(__dirname,'public')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
const port=process.env.PORT||5000;
if(!process.env.MONGODB_URI||!process.env.JWT_SECRET){console.error('Set MONGODB_URI and JWT_SECRET in .env before starting.');process.exit(1);}
mongoose.connect(process.env.MONGODB_URI).then(()=>app.listen(port,()=>{
  const url=`http://localhost:${port}`;
  console.log(`Bank Operations API listening on ${url}`);
  // Deadlock detection runs only when the user clicks Run detection.
  if(process.platform==='win32'){
    const {exec}=require('child_process');
    exec(`start "" "${url}"`,error=>{if(error)console.log(`Open ${url} in your browser.`)});
  }
})).catch(e=>{console.error('MongoDB connection failed:',e.message);process.exit(1);});
