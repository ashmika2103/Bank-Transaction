const mongoose = require('mongoose');
const accountSchema = new mongoose.Schema({
  accountNumber: { type: String, unique: true, index: true },
  holderName: { type: String, required: true },
  balance: { type: Number, min: 0, default: 0 },
  currency: { type: String, default: 'INR' },
  accountType: { type: String, default: 'Savings' },
  active: { type: Boolean, default: true }
}, { timestamps: true });
module.exports = mongoose.model('Account', accountSchema);
