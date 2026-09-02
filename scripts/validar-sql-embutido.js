/**
 * Impede que um backtick dentro de um comentário SQL feche o template literal do TypeScript.
 *
 * Já aconteceu três vezes em src/produtor/schema.ts. O tsc pega, mas o erro que ele dá é
 * "',' expected" numa linha aleatória do SQL — leva minutos para se ligar de que a causa é uma
 * crase num comentário sobre outra coisa. Esta checagem diz a causa direto.
 */
const fs = require('fs');
const path = require('path');

const ARQUIVOS = ['src/produtor/schema.ts'];
let problemas = 0;

for (const rel of ARQUIVOS) {
  const arquivo = path.join(process.cwd(), rel);
  if (!fs.existsSync(arquivo)) continue;
  const linhas = fs.readFileSync(arquivo, 'utf-8').split('\n');

  let dentroDeTemplate = false;
  linhas.forEach((linha, i) => {
    // As bordas do template são as linhas que abrem (`= \``) e fecham (uma crase sozinha).
    if (/=\s*`\s*$/.test(linha)) { dentroDeTemplate = true; return; }
    if (dentroDeTemplate && /^`;\s*$/.test(linha)) { dentroDeTemplate = false; return; }
    if (!dentroDeTemplate) return;
    if (linha.includes('`')) {
      console.error(
        `✗ ${rel}:${i + 1} — crase dentro do template SQL fecha a string do TypeScript.\n` +
        `  Use aspas no comentário: ${linha.trim().slice(0, 90)}`
      );
      problemas++;
    }
  });
}

if (problemas > 0) process.exit(1);
console.log('✓ SQL embutido sem crase solta');
