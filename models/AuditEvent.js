const mongoose = require('mongoose');
const auditSchema = new mongoose.Schema({ action: String, detail: String, transactionId: String, createdAt: {type: Date, default: Date.now} });
module.exports = mongoose.model('AuditEvent', auditSchema);
