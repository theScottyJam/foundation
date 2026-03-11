import fs from 'node:fs';
import { parse } from './parser.ts';
import { run, RuntimeError } from './runtime.ts';
import { checkSemantics, SemanticError, type SemanticCheckResults } from './semanticCheck.ts';
import { attachStdLib } from './stdLib.ts';

function compileAndRun(fileContents: string): void {
  const rootNode = attachStdLib(parse(fileContents));
  let semanticResults: SemanticCheckResults;
  try {
    semanticResults = checkSemantics(rootNode, fileContents);
  } catch (error) {
    if (error instanceof SemanticError) {
      console.error('Semantic Error: ' + error.message);
      return;
    }
    throw error;
  }

  try {
    run(rootNode, semanticResults, fileContents);
  } catch (error) {
    if (error instanceof RuntimeError) {
      console.error('Runtime Error: ' + error.message);
      return;
    }
    throw error;
  }
}

compileAndRun(fs.readFileSync('./src/program.txt', 'utf-8'));
