// Prepara a marca para o site a partir do PNG original.
//
// O arquivo que veio do designer tem 2048x2048 e 2 MB. Servir isso em toda
// visita seria absurdo, e o navegador ainda teria que reduzir na hora, com o
// resultado borrado que sempre sai de redimensionamento feito no HTML.
//
// Este script decodifica o PNG na mao (zlib do Node + desfiltragem das linhas),
// reduz por media de area — que preserva melhor as bordas curvas do que pegar
// o pixel mais proximo — e reescreve nos tamanhos que o site usa. Tambem
// reporta as cores exatas da marca, para o CSS nao ficar com valor chutado.
//
//   node scripts/build-brand.mjs <origem.png> [pasta-de-saida]
import { inflateSync, deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ------------------------------------------------------------- decodificacao

function lerChunks(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('nao e um PNG');
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const tam = buf.readUInt32BE(off);
    const tipo = buf.toString('ascii', off + 4, off + 8);
    chunks.push({ tipo, dados: buf.subarray(off + 8, off + 8 + tam) });
    off += 12 + tam;                 // 4 tamanho + 4 tipo + dados + 4 crc
  }
  return chunks;
}

const paeth = (a, b, c) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** PNG -> {largura, altura, rgba}. Aceita 8 bits em RGB ou RGBA. */
function decodificar(buf) {
  const chunks = lerChunks(buf);
  const ihdr = chunks.find((c) => c.tipo === 'IHDR').dados;
  const largura = ihdr.readUInt32BE(0);
  const altura = ihdr.readUInt32BE(4);
  const bits = ihdr[8];
  const tipoCor = ihdr[9];
  if (bits !== 8) throw new Error(`profundidade ${bits} nao suportada — use 8 bits por canal`);
  if (tipoCor !== 2 && tipoCor !== 6) throw new Error(`tipo de cor ${tipoCor} nao suportado — use RGB ou RGBA`);
  if (ihdr[12] !== 0) throw new Error('PNG entrelacado nao suportado');

  const canais = tipoCor === 6 ? 4 : 3;
  const cru = inflateSync(Buffer.concat(chunks.filter((c) => c.tipo === 'IDAT').map((c) => c.dados)));

  const linha = largura * canais;
  const saida = Buffer.alloc(largura * altura * 4);
  let anterior = Buffer.alloc(linha);

  for (let y = 0; y < altura; y++) {
    const filtro = cru[y * (linha + 1)];
    const atual = Buffer.from(cru.subarray(y * (linha + 1) + 1, (y + 1) * (linha + 1)));

    // Desfaz o filtro da linha. Sem isto a imagem sai como ruido colorido.
    for (let i = 0; i < linha; i++) {
      const a = i >= canais ? atual[i - canais] : 0;   // pixel a esquerda
      const b = anterior[i];                            // pixel acima
      const c = i >= canais ? anterior[i - canais] : 0; // diagonal
      switch (filtro) {
        case 1: atual[i] = (atual[i] + a) & 0xff; break;
        case 2: atual[i] = (atual[i] + b) & 0xff; break;
        case 3: atual[i] = (atual[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: atual[i] = (atual[i] + paeth(a, b, c)) & 0xff; break;
        default: break;                                  // 0 = sem filtro
      }
    }

    for (let x = 0; x < largura; x++) {
      const o = (y * largura + x) * 4, i = x * canais;
      saida[o] = atual[i]; saida[o + 1] = atual[i + 1]; saida[o + 2] = atual[i + 2];
      saida[o + 3] = canais === 4 ? atual[i + 3] : 255;
    }
    anterior = atual;
  }
  return { largura, altura, rgba: saida };
}

// ---------------------------------------------------------------- reducao

/** Media de area: cada pixel de saida e a media da regiao correspondente. */
function reduzir(src, lado) {
  const { largura: lw, altura: lh, rgba } = src;
  const out = Buffer.alloc(lado * lado * 4);
  const escX = lw / lado, escY = lh / lado;

  for (let y = 0; y < lado; y++) {
    const y0 = Math.floor(y * escY), y1 = Math.max(y0 + 1, Math.floor((y + 1) * escY));
    for (let x = 0; x < lado; x++) {
      const x0 = Math.floor(x * escX), x1 = Math.max(x0 + 1, Math.floor((x + 1) * escX));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * lw + sx) * 4;
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3]; n++;
        }
      }
      const o = (y * lado + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ------------------------------------------------------------- codificacao

const TABELA_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = TABELA_CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function chunk(tipo, dados) {
  const tam = Buffer.alloc(4); tam.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tam, corpo, crc]);
}

function codificar(rgba, lado) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lado, 0); ihdr.writeUInt32BE(lado, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const linhas = Buffer.alloc(lado * (lado * 4 + 1));
  for (let y = 0; y < lado; y++) {
    linhas[y * (lado * 4 + 1)] = 0;
    rgba.copy(linhas, y * (lado * 4 + 1) + 1, y * lado * 4, (y + 1) * lado * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(linhas, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ cores

const hex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

/** Cores da marca: a mais alta, a do meio e a mais baixa que nao sao fundo. */
function paleta(src) {
  const { largura, altura, rgba } = src;
  const naoFundo = (i) => rgba[i] + rgba[i + 1] + rgba[i + 2] > 90;   // ignora o preto
  const linhaDe = (y) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let x = 0; x < largura; x++) {
      const i = (y * largura + x) * 4;
      if (naoFundo(i)) { r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++; }
    }
    return n ? { hex: hex(Math.round(r / n), Math.round(g / n), Math.round(b / n)), n } : null;
  };

  let topo = null, base = null;
  for (let y = 0; y < altura && !topo; y++) { const c = linhaDe(y); if (c && c.n > largura * 0.01) topo = { y, ...c }; }
  for (let y = altura - 1; y >= 0 && !base; y--) { const c = linhaDe(y); if (c && c.n > largura * 0.01) base = { y, ...c }; }
  const meio = topo && base ? { y: Math.round((topo.y + base.y) / 2), ...linhaDe(Math.round((topo.y + base.y) / 2)) } : null;

  // fundo: canto superior esquerdo
  return { fundo: hex(rgba[0], rgba[1], rgba[2]), topo, meio, base };
}

// ------------------------------------------------------------------ saida

const origem = process.argv[2];
if (!origem) { console.error('uso: node scripts/build-brand.mjs <origem.png> [pasta]'); process.exit(1); }
const destino = process.argv[3] || './logo';
mkdirSync(destino, { recursive: true });

const src = decodificar(readFileSync(origem));
console.log(`origem ......... ${src.largura}x${src.altura}`);

const p = paleta(src);
console.log('\nCORES DA MARCA');
console.log(`  fundo ........ ${p.fundo}`);
console.log(`  topo ......... ${p.topo?.hex}  (linha ${p.topo?.y})`);
console.log(`  meio ......... ${p.meio?.hex}  (linha ${p.meio?.y})`);
console.log(`  base ......... ${p.base?.hex}  (linha ${p.base?.y})`);

console.log('\nARQUIVOS');
for (const lado of [512, 256, 180, 128, 64, 32]) {
  const arquivo = join(destino, `brand-${lado}.png`);
  const bytes = codificar(reduzir(src, lado), lado);
  writeFileSync(arquivo, bytes);
  console.log(`  ${arquivo}  ${lado}x${lado}  ${(bytes.length / 1024).toFixed(1)} kb`);
}
