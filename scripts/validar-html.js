#!/usr/bin/env node
/**
 * Valida o JavaScript embutido nas páginas HTML do admin.
 *
 * Por que existe: em 08/08/2026 um bloco de código morto sobreviveu a uma refatoração e deixou
 * `const naoClass` declarado duas vezes no mesmo escopo. O `tsc` passou — ele não olha JS dentro
 * de HTML — o deploy foi feito, e a página inteira parou de carregar em produção: erro de sintaxe
 * derruba o script todo, não só a função afetada. A tela ficou em "Carregando..." para sempre.
 *
 * Um `npm run build` verde dava a impressão de que estava tudo certo. Não dava: metade do código
 * do painel não estava sendo verificada por nada.
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'admin');
const arquivos = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));

let falhas = 0;

for (const arquivo of arquivos) {
  const html = fs.readFileSync(path.join(dir, arquivo), 'utf8');

  // Só blocos inline: script com src é arquivo externo e não é nosso.
  const blocos = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];

  blocos.forEach((m, i) => {
    try {
      new Function(m[1]);
    } catch (err) {
      // Linha aproximada dentro do arquivo, pra não obrigar a caçar o bloco no olho.
      const linhaDoBloco = html.slice(0, m.index).split('\n').length;
      console.error(`✗ ${arquivo} · bloco ${i + 1} (a partir da linha ~${linhaDoBloco}): ${err.message}`);
      falhas++;
    }
  });

  // Marcação desbalanceada não quebra o navegador, mas produz layout errado silencioso — e a
  // primeira vítima costuma ser um card inteiro que some sem aviso.
  const abre = (html.match(/<div\b/g) || []).length;
  const fecha = (html.match(/<\/div>/g) || []).length;
  if (abre !== fecha) {
    console.error(`✗ ${arquivo}: <div> desbalanceado — ${abre} abrem, ${fecha} fecham`);
    falhas++;
  }
}

if (falhas > 0) {
  console.error(`\n${falhas} problema(s) encontrado(s).`);
  process.exit(1);
}
console.log(`✓ ${arquivos.length} arquivo(s) HTML sem erro de sintaxe`);
