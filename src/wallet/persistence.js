// Os dados estao num volume de verdade, ou numa pasta que some no redeploy?
//
// Isto existe por causa de uma falha real, e do jeito mais assustador possivel:
// o servidor subiu, aceitou cadastro, gerou carteiras, mostrou endereco de
// deposito — e no redeploy seguinte os agentes tinham desaparecido. Nada deu
// erro em momento nenhum. Sem volume montado, /data e apenas um diretorio
// dentro do container: escreve, le, funciona, e o container inteiro e jogado
// fora no proximo deploy levando as chaves privadas junto.
//
// A deteccao e simples: num container, o volume montado e um dispositivo de
// bloco diferente do sistema de arquivos raiz. Se /data estiver no MESMO
// dispositivo que /, nao ha volume nenhum ali.
import { statSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

/**
 * @returns {{checked:boolean, persistent:boolean|null, dir:string, reason:string|null}}
 *
 * `checked:false` quando a pergunta nao se aplica (rodando fora de container,
 * ou com caminho relativo dentro da propria pasta do projeto). Igual ao resto
 * do projeto: quando a checagem nao completa, o resultado e `null`, nunca um
 * palpite — falha de deteccao nao pode virar veredito.
 */
export function dataPersistence(env = process.env) {
  const dbPath = env.PONS_DB || './data/pons.sqlite';
  const dir = dirname(resolve(dbPath));

  // A comparacao de dispositivo so faz sentido no Linux, que e onde o
  // container roda. No Windows e no macOS a pergunta nao se aplica.
  if (process.platform !== 'linux') {
    return { checked: false, persistent: null, dir, reason: 'not running on linux' };
  }
  if (!isAbsolute(dbPath) || dir.startsWith(resolve(process.cwd()) + sep) || dir === resolve(process.cwd())) {
    return { checked: false, persistent: null, dir, reason: 'data lives inside the project folder' };
  }

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const dados = statSync(dir);
    const raiz = statSync('/');
    return {
      checked: true,
      persistent: dados.dev !== raiz.dev,
      dir,
      reason: dados.dev === raiz.dev
        ? `${dir} is on the container filesystem, not on a mounted volume`
        : null,
    };
  } catch (err) {
    // Nao conseguir checar nao e o mesmo que estar errado.
    return { checked: false, persistent: null, dir, reason: err.message };
  }
}

/** Frase para o operador, dizendo o proximo passo e nao so o problema. */
export const persistenceWarning = (p) =>
  'FATAL RISK: agent keystores are NOT on a persistent volume.\n' +
  `         ${p.dir} lives inside the container and is DELETED on every redeploy.\n` +
  '         Anyone who deposits will lose their funds the next time you deploy.\n' +
  '         Fix: create a volume on your host and mount it at exactly this path.\n' +
  '         Creating agents is blocked until then (reading, exporting and\n' +
  '         withdrawing stay open). Override with PONS_ALLOW_EPHEMERAL_DATA=1\n' +
  '         only if you are deliberately running a throwaway instance.';

/**
 * Bloqueia a criacao de agentes quando o armazenamento e efemero.
 *
 * So a CRIACAO. Ler, exportar keystore e sacar continuam livres, pelo mesmo
 * principio que vale na manutencao: quem ja tem dinheiro la dentro precisa
 * conseguir tirar, aconteca o que acontecer.
 */
export function assertCanCreateAgents(env = process.env) {
  if (env.PONS_ALLOW_EPHEMERAL_DATA === '1') return;
  const p = dataPersistence(env);
  if (p.checked && p.persistent === false) {
    throw new Error(
      'this server is not configured to keep agent keys safe: the data directory is not ' +
      'on a persistent volume, so keystores would be destroyed on the next deploy. ' +
      'Creating agents is disabled until the operator mounts a volume.',
    );
  }
}
