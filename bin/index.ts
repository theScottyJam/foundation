import { compileBlueprint } from './blueprint/index.ts';

compileBlueprint(
  './example.blueprint',
  './example.bedrock.json',
);

// import fs from 'node:fs';
// import { main } from './jsCompiler/index.ts';

// const bedrockData = JSON.parse(fs.readFileSync('./src.bedrock.json', 'utf-8'));

// // Remove comments
// bedrockData.relationships = bedrockData.relationships.filter((relationship: any) => typeof relationship !== 'string');

// const program = main(bedrockData);
// fs.writeFileSync('build.js', program);
