// Sobe o site e um túnel da Cloudflare, e grava o endereço público num arquivo.
//
// Existe por um motivo bem específico: o cloudflared imprime o endereço no meio
// de um bloco de log, e copiar dali com o mouse corta pedaço — foi exatamente o
// que aconteceu num teste real, o link chegou sem a primeira palavra e o
// navegador do outro lado disse "servidor não encontrado".
//
// Aqui o endereço é extraído do fluxo de saída e escrito em LINK-DO-SITE.txt.
// Você abre o arquivo e copia com Ctrl+A, Ctrl+C. Sem seleção com o mouse, sem
// risco de perder caractere.
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
const LINK_FILE = join(ROOT, 'LINK-DO-SITE.txt');
const CLOUDFLARED = join(ROOT, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

const line = (s = '') => process.stdout.write(s + '\n');

if (!existsSync(CLOUDFLARED)) {
  line('\n  cloudflared nao encontrado nesta pasta.');
  line('  Rode o PUBLICAR-TEMPORARIO.bat, que baixa ele automaticamente.\n');
  process.exit(1);
}

// 1. o site
const server = spawn(process.execPath, [join(ROOT, 'src', 'web', 'server.js')], {
  cwd: ROOT,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(d));
server.stderr.on('data', (d) => {
  const text = String(d);
  // repassa avisos úteis, esconde o ruído do node:sqlite experimental
  if (!/ExperimentalWarning|trace-warnings/.test(text)) process.stderr.write(text);
});

await new Promise((r) => setTimeout(r, 2500));

// 2. o túnel
line('\n  Abrindo o tunel, aguarde...\n');
const tunnel = spawn(CLOUDFLARED, ['tunnel', '--url', `http://127.0.0.1:${PORT}`], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let publicUrl = null;
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function onOutput(chunk) {
  const text = String(chunk);
  if (!publicUrl) {
    const found = text.match(URL_RE);
    if (found) {
      publicUrl = found[0];
      announce();
    }
  }
}
tunnel.stdout.on('data', onOutput);
tunnel.stderr.on('data', onOutput);

function announce() {
  const body = [
    'Endereco publico do seu site',
    '',
    publicUrl,
    '',
    'Para a landing ......... ' + publicUrl,
    'Para o demo ............ ' + publicUrl + '/demo',
    'Para o app ............. ' + publicUrl + '/app',
    '',
    'Copie a linha inteira. Ela vale enquanto a janela preta',
    'estiver aberta. Ao fechar, este endereco morre e o proximo',
    'sera diferente.',
    '',
  ].join('\r\n');
  writeFileSync(LINK_FILE, body, 'utf8');

  const bar = '='.repeat(60);
  line('');
  line('  ' + bar);
  line('   SEU LINK ESTA PRONTO');
  line('  ' + bar);
  line('');
  line('   ' + publicUrl);
  line('');
  line('   Tambem salvei em: LINK-DO-SITE.txt');
  line('   Abra esse arquivo e copie com Ctrl+A, Ctrl+C.');
  line('   Copiar daqui com o mouse costuma cortar o comeco.');
  line('');
  line('  ' + bar);
  line('');

  // abre o arquivo para o usuario copiar sem risco
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', 'notepad', LINK_FILE], { detached: true, stdio: 'ignore' }).unref();
  }
}

const stop = () => {
  tunnel.kill();
  server.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
tunnel.on('exit', () => { line('\n  Tunel encerrado.\n'); server.kill(); process.exit(0); });

setTimeout(() => {
  if (!publicUrl) {
    line('\n  Ainda sem endereco depois de 45 segundos.');
    line('  Verifique a internet e feche esta janela para tentar de novo.\n');
  }
}, 45_000);
