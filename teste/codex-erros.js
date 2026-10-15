'use strict';
/*
 * teste/codex-erros.js — falhas de verdade (RPC, sistema de arquivos,
 * argumentos) no modo Codex: todas saem em JSON estável, com código de saída.
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cota-erros-'));
const fake = path.join(temp, 'rpc.js');
fs.writeFileSync(fake, `
require('readline').createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') console.log(JSON.stringify({id:m.id,result:{}}));
 if(m.method==='account/rateLimits/read') console.log(JSON.stringify({id:m.id,error:{message:'not authenticated'}}));
});`);
let passed = 0;
function run(args, dir, extra = {}) {
 const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'cota.js'), '--codex', ...args], {
  env: {...process.env, COTA_CODEX_DIR:dir, COTA_CODEX:fake, COTA_SONDANDO:'', ...extra},
  encoding:'utf8', windowsHide:true, timeout:15000,
 });
 assert.ifError(r.error);
 assert.equal(r.stderr, '');
 return {code:r.status, body:args.includes('--json') ? JSON.parse(r.stdout) : r.stdout};
}
function test(name, fn) { fn(); passed++; console.log('PASS '+name); }
try {
 test('falha RPC retorna JSON e exit 1 em sondar/status/cabe/audit', () => {
  for(const args of [['sondar'], [], ['cabe','4'], ['audit']]) {
   const r=run([...args,'--json'],path.join(temp,'rpc-state'));
   assert.equal(r.code,1); assert.equal(r.body.ok,false);
   assert.match(r.body.erro.codigo,/SONDA_FALHOU|AUDIT_FALHOU/);
   assert.match(JSON.stringify(r.body),/not authenticated/);
  }
 });
 test('falha RPC em texto também retorna exit 1', () => {
  const r=run(['sondar'],path.join(temp,'texto'));
  assert.equal(r.code,1); assert.match(r.body,/not authenticated/);
 });
 test('arquivo como diretório de cache preserva erro real', () => {
  const dir=path.join(temp,'arquivo'); fs.writeFileSync(dir,'x');
  for(const args of [[],['sondar'],['audit'],['cabe','4']]) {
   const r=run([...args,'--json'],dir);
   assert.equal(r.code,1); assert.equal(r.body.ok,false);
   assert.match(r.body.erro.codigo,/EEXIST|ENOTDIR/);
  }
 });
 test('destino sonda.json como diretório não mascara falha de rename', () => {
  const dir=path.join(temp,'rename'); fs.mkdirSync(path.join(dir,'sonda.json'),{recursive:true});
  const r=run(['sondar','--json'],dir);
  assert.equal(r.code,1); assert.equal(r.body.ok,false);
  assert.match(r.body.erro.codigo,/EPERM|EACCES|EISDIR|ENOTEMPTY/);
  if(/EPERM|EACCES/.test(r.body.erro.codigo)) assert.match(r.body.erro.acao,/sandbox/);
 });
 test('desativado e argumentos inválidos sempre produzem JSON', () => {
  const dir=path.join(temp,'off'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir,'config.json'),'{"ligado":false}');
  assert.equal(run(['cabe','4','--json'],dir).code,2);
  assert.equal(run(['--json'],dir).body.erro.codigo,'DESATIVADA');
  assert.equal(run(['cabe','--json'],dir).body.erro.codigo,'ARGUMENTO_INVALIDO');
  assert.equal(run(['inexistente','--json'],dir).body.erro.codigo,'COMANDO_INVALIDO');
  assert.equal(run(['config','inexistente','1','--json'],dir).code,1);
  assert.equal(run(['off','--json'],dir).body.ok,true);
 });
 test('sem executável identificado produz erro estruturado', () => {
  const r=run(['--json'],path.join(temp,'missing'),{COTA_CODEX:path.join(temp,'nao-existe')});
  assert.equal(r.code,1); assert.equal(r.body.erro.codigo,'SONDA_FALHOU');
 });
 console.log(passed+' testes de erros passaram.');
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
