import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { passwordRecord } from '../server/service.mjs';

const username = process.argv[2] || 'owner';
const directory = resolve(process.env.CLEANROOM_DATA_DIR || '.large-data');
await mkdir(directory, { recursive: true, mode: 0o700 });
const path = join(directory, 'users.json');
const users = JSON.parse(
  await readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return '[]';
    throw error;
  }),
);
if (users.some((user) => user.username === username)) {
  throw new Error(
    'That account already exists. Choose a different account name.',
  );
}
const password = randomBytes(18).toString('base64url');
users.push(await passwordRecord(username, password));
await writeFile(path, JSON.stringify(users, null, 2), { mode: 0o600 });
const access = join(directory, `${username}-access.txt`);
await writeFile(
  access,
  `Cleanroom Detective private workspace\nAccount: ${username}\nPassword: ${password}\n\nKeep this file private. Restart the processor after adding an account.\n`,
  { mode: 0o600 },
);
console.log(
  `Account created. Your sign-in details are saved privately in ${access}`,
);
