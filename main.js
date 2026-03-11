import path from 'node:path';

process.chdir(path.dirname(import.meta.url.replace(/^file:\/\//, '')));

import('./bin/index.ts');
