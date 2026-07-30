// Relatório local dos agentes: existe banco? existem agentes? de quem são?
// o keystore (a chave privada) ainda está no disco?
//
// Escrito para o caso "atualizei a página e meu agente sumiu". Sumir da tela e
// sumir do disco são duas coisas muito diferentes: a primeira é incômodo, a
// segunda é perda de fundos. Este relatório separa uma da outra sem tocar em
// nada — só lê.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = resolve(process.env.PONS_DB || join(ROOT, 'data', 'pons.sqlite'));
const KEYSTORE_DIR = resolve(process.env.PONS_KEYSTORE_DIR || join(ROOT, 'data', 'keystores'));

const line = (s = '') => process.stdout.write(s + '\n');
const bar = '='.repeat(62);

line('');
line('  ' + bar);
line('   RELATORIO DOS SEUS AGENTES');
line('  ' + bar);
line('');
line('  Banco de dados : ' + DB_PATH);
line('  Chaves         : ' + KEYSTORE_DIR);
line('');

if (!existsSync(DB_PATH)) {
  line('  [X] O ARQUIVO DO BANCO NAO EXISTE NESTA PASTA.');
  line('');
  line('      Isso quer dizer que esta pasta nunca rodou o site, ou que a');
  line('      pasta "data" foi apagada / ficou para tras numa versao antiga.');
  line('');
  line('      A pasta "data" NAO vem dentro do zip, de proposito: ela guarda');
  line('      suas chaves privadas. Se voce extraiu o zip novo numa pasta');
  line('      nova, seus agentes continuam na pasta ANTIGA.');
  line('');
  line('      O que fazer:');
  line('        1. Procure no computador por uma pasta chamada pons-mm ou');
  line('           Tsunami que tenha dentro dela uma pasta "data".');
  line('           (A ferramenta mudou de nome. As pastas antigas se chamam');
  line('            pons-mm; as novas, Tsunami.)');
  line('        2. Copie essa pasta "data" inteira para dentro desta pasta:');
  line('           ' + ROOT);
  line('        3. Rode este arquivo de novo.');
  line('');
  process.exit(0);
}

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(DB_PATH);

let agents = [];
try {
  agents = db.prepare('SELECT id, label, address, keystore_path, owner, status, target_token, created_at FROM agents ORDER BY created_at').all();
} catch (err) {
  line('  [X] Nao consegui ler a tabela de agentes: ' + err.message);
  process.exit(1);
}

if (agents.length === 0) {
  line('  O banco existe, mas nao ha NENHUM agente gravado nele.');
  line('');
  line('  Se voce criou um agente antes, ele foi criado em outra pasta.');
  line('  Procure por outra pasta (pons-mm ou Tsunami) com "data" dentro.');
  line('');
  process.exit(0);
}

line(`  ${agents.length} agente(s) encontrado(s):`);
line('');

for (const a of agents) {
  const ksPath = a.keystore_path ? resolve(ROOT, a.keystore_path) : null;
  const hasKey = ksPath && existsSync(ksPath);
  line('  ' + '-'.repeat(58));
  line('   nome           : ' + (a.label || '(sem nome)'));
  line('   carteira       : ' + a.address);
  line('   dono (login)   : ' + (a.owner || '(nenhum - criado antes do login existir)'));
  line('   status         : ' + a.status);
  line('   token alvo     : ' + (a.target_token || '-'));
  line('   criado em      : ' + new Date(a.created_at * 1000).toLocaleString());
  line('   chave privada  : ' + (hasKey ? 'OK, esta salva no disco' : '[X] ARQUIVO NAO ENCONTRADO'));
  if (hasKey) {
    try {
      const raw = JSON.parse(readFileSync(ksPath, 'utf8'));
      const sealed = !!raw.envelope || !!raw.ciphertext && !raw.crypto;
      line('   arquivo        : ' + ksPath + '  (' + statSync(ksPath).size + ' bytes' + (sealed ? ', selado' : '') + ')');
    } catch { line('   arquivo        : ' + ksPath); }
  } else if (ksPath) {
    line('   deveria estar  : ' + ksPath);
  }
}
line('  ' + '-'.repeat(58));
line('');

const owners = [...new Set(agents.map((a) => (a.owner || '').toLowerCase()).filter(Boolean))];
if (owners.length) {
  line('  IMPORTANTE: no site, cada agente so aparece para a conta que o criou.');
  line('  Conecte na MetaMask exatamente uma destas contas:');
  line('');
  for (const o of owners) {
    const c = agents.find((a) => (a.owner || '').toLowerCase() === o);
    line('    ' + (c.owner));
  }
  line('');
  line('  Se voce conectou uma conta diferente, a lista aparece vazia: o');
  line('  agente nao sumiu, ele so pertence a outra conta. Troque de conta');
  line('  na MetaMask e atualize a pagina.');
  line('');
}

const orphan = agents.filter((a) => !a.owner);
if (orphan.length) {
  line('  ' + orphan.length + ' agente(s) sem dono. Eles nao aparecem no site.');
  line('  Para adotar todos com a conta que voce usa no login, rode:');
  line('');
  line('    node scripts\\agents-report.mjs --adotar 0xSEU_ENDERECO');
  line('');
}

const adoptIdx = process.argv.indexOf('--adotar');
if (adoptIdx !== -1) {
  const addr = process.argv[adoptIdx + 1];
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr || '')) {
    line('  [X] Endereco invalido depois de --adotar.');
    process.exit(1);
  }
  const r = db.prepare('UPDATE agents SET owner = ? WHERE owner IS NULL').run(addr);
  line('  ' + r.changes + ' agente(s) agora pertencem a ' + addr + '.');
  line('  Atualize a pagina do site com essa conta conectada.');
  line('');
}

line('  Nada foi alterado alem do que esta escrito acima.');
line('');
