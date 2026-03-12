import fs from 'node:fs';
import { main } from './jsCompiler/index.ts';

const bedrockData = JSON.parse(fs.readFileSync('./src.bedrock.json', 'utf-8'));

main(bedrockData);
