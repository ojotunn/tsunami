// Gera o logo do Tsunami em PNG, sem dependencia nenhuma.
//
// Rasteriza os tracos vetoriais na mao: achata as curvas de Bezier em
// polilinhas, calcula a distancia de cada pixel ate elas e usa essa distancia
// como cobertura antisserrilhada. Depois codifica o PNG com o zlib do proprio
// Node. E mais codigo do que chamar uma biblioteca, mas mantem a regra do
// projeto: nada de npm install num repositorio que guarda chaves privadas.
//
//   node scripts/build-logo.mjs [pasta-de-saida]
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- desenho

const AZUL = [0x5a, 0xa2, 0xff];
const BRANCO = [0xff, 0xff, 0xff];

// As tres ondas, no espaco 32x32 do SVG. Cada uma e uma curva cubica seguida
// de uma curva "suave" (S), cujo primeiro controle e o reflexo do anterior.
const ONDAS = [0, 7, 14].map((dy, i) => ({
  // A hierarquia de opacidade da a ideia de ondas somando forca. No site dava
  // para ser sutil (1 / 0.7 / 0.42), mas como avatar de token a 24px o traco
  // mais fraco se dissolvia no azul — legibilidade ganha da sutileza aqui.
  opacidade: [1, 0.86, 0.72][i],
  cubicas: [
    [[4, 10.5 + dy], [7, 6.5 + dy], [11, 6.5 + dy], [14, 10.5 + dy]],
    [[14, 10.5 + dy], [17, 14.5 + dy], [21, 14.5 + dy], [24, 10.5 + dy]],
  ],
}));

const ESPESSURA = 3.1;   // no espaco 32x32, igual ao SVG
const ESCALA = 0.8;      // encolhe a marca para respirar dentro do circulo
const CENTRO = [14, 17.5];

/** Achata uma cubica em pontos. 24 segmentos ja passa do limite do olho. */
function achatar([p0, p1, p2, p3], n = 24) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return pts;
}

/** Aplica o enquadramento: centraliza a marca e encolhe. */
const enquadrar = ([x, y]) => [
  16 + (x - CENTRO[0]) * ESCALA,
  16 + (y - CENTRO[1]) * ESCALA,
];

const POLILINHAS = ONDAS.map((o) => ({
  opacidade: o.opacidade,
  pontos: o.cubicas.flatMap((c) => achatar(c)).map(enquadrar),
}));

/** Distancia de um ponto ate um segmento. */
function distSegmento(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

const distPolilinha = (px, py, pts) => {
  let m = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = distSegmento(px, py, pts[i - 1], pts[i]);
    if (d < m) m = d;
  }
  return m;
};

/** Cobertura suave: 1 dentro, 0 fora, transicao de meio pixel na borda. */
const cobertura = (dist, raio, px) => {
  const b = px * 0.75;                       // largura da transicao
  if (dist <= raio - b) return 1;
  if (dist >= raio + b) return 0;
  return (raio + b - dist) / (2 * b);
};

/** Desenha o logo num buffer RGBA de lado x lado. */
function desenhar(lado) {
  const px = 32 / lado;                       // tamanho do pixel no espaco 32x32
  const raioTraco = ESPESSURA * ESCALA / 2;
  const buf = Buffer.alloc(lado * lado * 4);

  for (let y = 0; y < lado; y++) {
    for (let x = 0; x < lado; x++) {
      const u = (x + 0.5) * px, v = (y + 0.5) * px;

      // fundo: circulo azul cheio
      const aCirculo = cobertura(Math.hypot(u - 16, v - 16), 16, px);
      let r = AZUL[0], g = AZUL[1], b = AZUL[2], a = aCirculo;

      // marca: ondas brancas por cima, da mais fraca para a mais forte
      for (const onda of POLILINHAS) {
        const c = cobertura(distPolilinha(u, v, onda.pontos), raioTraco, px) * onda.opacidade;
        if (c <= 0) continue;
        r = r * (1 - c) + BRANCO[0] * c;
        g = g * (1 - c) + BRANCO[1] * c;
        b = b * (1 - c) + BRANCO[2] * c;
      }

      const i = (y * lado + x) * 4;
      buf[i] = Math.round(r); buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b); buf[i + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

// ------------------------------------------------------------ codificacao

const TABELA_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = TABELA_CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(tipo, dados) {
  const tam = Buffer.alloc(4);
  tam.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tam, corpo, crc]);
}

function png(rgba, lado) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lado, 0);
  ihdr.writeUInt32BE(lado, 4);
  ihdr[8] = 8;    // bits por canal
  ihdr[9] = 6;    // RGBA
  // 10, 11, 12 = compressao, filtro e entrelacamento padrao (zero)

  // cada linha leva um byte de filtro na frente; filtro 0 = sem filtro
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

// ------------------------------------------------------------------ saida

const destino = process.argv[2] || './logo';
mkdirSync(destino, { recursive: true });

for (const lado of [1024, 512, 256, 128, 64, 32]) {
  const arquivo = join(destino, `tsunami-${lado}.png`);
  const bytes = png(desenhar(lado), lado);
  writeFileSync(arquivo, bytes);
  console.log(`${arquivo}  ${lado}x${lado}  ${(bytes.length / 1024).toFixed(1)} kb`);
}
