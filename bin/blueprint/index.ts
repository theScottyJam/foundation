import fs from 'node:fs';
import { parse } from './parser.ts';

export function compileBlueprint(inPath: string, outPath: string) {
  const text = fs.readFileSync(inPath, 'utf-8');
  const parsed = parse(text);
  fs.writeFileSync(outPath, JSON.stringify(parsed, undefined, 2));
}
