
import mongoose from 'mongoose';

const roomSchema = new mongoose.Schema({
  roomId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  code: {
    type: String,
    default: ""
  },
  language: {
    type: String,
    default: "javascript"
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastModified: {
    type: Date,
    default: Date.now
  },
  activeUsers: [{
    type: String
  }]
}, {
  timestamps: true
});

// Add index for better performance
roomSchema.index({ lastModified: -1 });

export default mongoose.model('Room', roomSchema);
