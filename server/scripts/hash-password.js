// Makes the value for ADMIN_PASSWORD_HASH (so the plain password is not stored on the server).
// Usage: npm run hash-password -- "your long password"
import {hashPassword} from '../src/security/auth.js';
const password = process.argv[2] || '';
if (password.length < 10) { console.error('Give a password of at least 10 characters: npm run hash-password -- "your long password"'); process.exit(1); }
console.log(hashPassword(password));
