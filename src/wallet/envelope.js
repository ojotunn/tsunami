// Envelope de servidor sobre o keystore.
//
// O keystore V3 já é cifrado com a senha do usuário. Este envelope acrescenta
// uma segunda camada com uma chave que vive FORA do volume — em `fly secrets`,
// no ambiente do container, num cofre. O objetivo é específico e vale ser dito
// com precisão:
//
//   protege contra: snapshot do volume, backup vazado, disco descartado,
//                   alguém com acesso de leitura ao armazenamento.
//   NÃO protege contra: servidor comprometido em execução — nesse caso o
//                   atacante tem o arquivo e a variável de ambiente juntos.
//
// Para o segundo caso a resposta é KMS/HSM, onde a chave nunca sai do módulo.
// Este envelope é o passo intermediário honesto, não a solução final.
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';

const MAGIC = 'pons-env-v1';

export const masterKey = () => process.env.PONS_MASTER_KEY || null;

/** Gera uma chave mestra nova para o operador guardar fora do servidor. */
export const generateMasterKey = () => randomBytes(32).toString('hex');

function derive(keyHex, salt) {
  const raw = Buffer.from(keyHex, 'hex');
  if (raw.length < 32) throw new Error('PONS_MASTER_KEY must be at least 32 bytes in hex (64 characters)');
  return Buffer.from(hkdfSync('sha256', raw, salt, Buffer.from(MAGIC), 32));
}

/** Cifra o JSON do keystore. Sem chave mestra, devolve como estava. */
export function seal(keystoreJson, key = masterKey()) {
  if (!key) return keystoreJson;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(key, salt), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(keystoreJson), 'utf8'), cipher.final()]);
  return {
    envelope: MAGIC,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: body.toString('base64'),
  };
}

/** Abre o envelope. Aceita arquivos antigos sem envelope, para não quebrar migração. */
export function open(stored, key = masterKey()) {
  if (!stored || stored.envelope !== MAGIC) return stored;
  if (!key) {
    throw new Error(
      'this keystore is sealed with a server master key and PONS_MASTER_KEY is not set — ' +
      'the agent cannot be unlocked without it',
    );
  }
  const decipher = createDecipheriv('aes-256-gcm', derive(key, Buffer.from(stored.salt, 'hex')), Buffer.from(stored.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(stored.tag, 'hex'));
  try {
    const plain = Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new Error('could not open the keystore envelope — wrong PONS_MASTER_KEY, or the file was tampered with');
  }
}

export const isSealed = (stored) => stored?.envelope === MAGIC;

/** Aviso de arranque, para ninguém subir em produção sem perceber. */
export function warnIfUnsealed(log = console.warn) {
  if (!masterKey()) {
    log(
      'WARNING: PONS_MASTER_KEY is not set. Agent keystores are written protected only by\n' +
      '         each user password. Anyone who copies the data volume gets those files.\n' +
      '         Generate one with:  node src/cli.js master-key',
    );
    return false;
  }
  return true;
}
