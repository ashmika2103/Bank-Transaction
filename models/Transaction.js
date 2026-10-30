const mongoose = require('mongoose');
const transactionSchema = new mongoose.Schema({
  transactionId: { type: String, unique: true, index: true },
  type: { type: String, enum: ['Deposit','Withdrawal','Fund Transfer','Payment'], required: true },
  sourceAccount: { type: String, default: '' },
  destinationAccount: { type: String, default: '' },
  amount: { type: Number, required: true, min: 0.01 },
  status: { type: String, enum: ['WAITING','ACTIVE','COMPLETED','ABORTED','DEADLOCKED'], default: 'WAITING', index: true },
  lockHeld: { type: String, default: '' },
  waitsFor: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  completedAt: { type: Date },
  note: { type: String, default: '' }
}, { timestamps: true });
module.exports = mongoose.model('Transaction', transactionSchema);
