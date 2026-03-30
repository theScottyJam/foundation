import fs from 'node:fs';
import childProcess from 'node:child_process';
import { bedrockToJs } from './jsCompiler/index.ts';
import { blueprintToBedrock } from './blueprint/index.ts';
import type { BedrockData, RelationshipData } from './types.ts';

function formatBedrockData(bedrockData: BedrockData) {
  const reprRelationship = (relationship: RelationshipData) => {
    return (
      relationship.type +
      '( ' +
      Object.entries(relationship.mapping).map(([key, value]) => `${key} = ${value}`).join(', ') +
      ' )'
    );
  };

  const lines: string[] = [];
  for (const relationship of bedrockData.relationships) {
    lines.push(reprRelationship(relationship));
  }

  lines.push('');
  for (const [uuid, nodeId] of Object.entries(bedrockData.links)) {
    lines.push(`link ${nodeId} to ${uuid}`);
  }

  return lines.join('\n');
}

console.info('-- blueprint to bedrock --');

const bedrockData: BedrockData = blueprintToBedrock(fs.readFileSync('./src.blueprint', 'utf-8'));
fs.writeFileSync('./src.bedrock', formatBedrockData(bedrockData));
// fs.writeFileSync('./src.bedrock.json', JSON.stringify(bedrockData, undefined, 2));

console.info('-- bedrock to js --');

const jsCode = bedrockToJs(bedrockData);
fs.writeFileSync('build.js', jsCode);

console.info('-- execute --');

childProcess.execSync('node ./build.js', { stdio: 'inherit' });
