import { readFileSync } from 'node:fs'

const s = readFileSync('dodumodu_backend/src/generated/site.ts', 'utf8')
const m = s.match(/export const CSP = ("(?:[^"\\]|\\.)*")\n/)
console.log('CSP:', m ? JSON.parse(m[1]) : 'not found')
