import fs from 'node:fs';
import childProcess from 'node:child_process';
import { bedrockToJs } from './jsCompiler/index.ts';
import { blueprintToBedrock } from './blueprint/index.ts';

console.info('-- blueprint to bedrock --');

const bedrockData = blueprintToBedrock(fs.readFileSync('./example.blueprint', 'utf-8'));
fs.writeFileSync('./example.bedrock.json', JSON.stringify(bedrockData, undefined, 2));

console.info('-- bedrock to js --');

const jsCode = bedrockToJs(bedrockData);
fs.writeFileSync('build.js', jsCode);

console.info('-- execute --');

childProcess.execSync('node ./build.js', { stdio: 'inherit' });
