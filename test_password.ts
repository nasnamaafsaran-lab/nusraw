import { comparePasswordSync, hashPasswordSync } from './server/utils/password.js';

const hash = hashPasswordSync('123');
console.log('Hashed 123:', hash);
console.log('Compare 123 with hash:', comparePasswordSync('123', hash));
console.log('Compare 123 with plain text 123:', comparePasswordSync('123', '123'));
console.log('Compare 123 with plain text 1234:', comparePasswordSync('123', '1234'));
