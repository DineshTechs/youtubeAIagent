import mongoose from 'mongoose';
// Home page details (one document, key 'global'), edited in Settings → Home page.
const schema = new mongoose.Schema({
  key: {type: String, unique: true, default: 'global'},
  site: {type: mongoose.Schema.Types.Mixed, default: () => ({})}
}, {timestamps: true});
export default mongoose.models.SiteSettings || mongoose.model('SiteSettings', schema);
