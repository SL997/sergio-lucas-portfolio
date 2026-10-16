# Landing page — Sergio Lucas

Portfólio pessoal com fundo 3D em tempo real controlado pela rolagem (`background-scene.js`, Three.js). A câmera percorre uma jornada contínua: processador e circuitos, arquitetura de software, rede neural, ecossistema digital e um horizonte final. Cada seção da página ancora um momento da jornada, e rolar para cima reverte o movimento. O crachá, sua animação de entrada e seu retorno no contato foram preservados.

No tema claro, a mesma cena é exibida em tons de grafite sobre o tom de papel da página; a troca de tema faz uma transição suave. A resolução se adapta ao desempenho do aparelho, e a preferência por movimento reduzido desacelera as animações.

## Ver localmente

```powershell
node serve.mjs . 5395
```

Abra `http://localhost:5395/`. O servidor oferece suporte a requisições parciais para navegar no vídeo.

## Publicar

O código está no GitHub (`SL997/sergio-lucas-portfolio`) e a Vercel publica automaticamente a cada `git push` na branch `main`. O site é estático: não há etapa de build.

Apenas `index.html`, `background-scene.js` e as imagens `img/*.webp` fazem parte do site (veja `.gitignore` e `.vercelignore`); vídeos, backups e arquivos de trabalho ficam somente no computador. O Three.js é carregado do CDN jsDelivr (versão 0.160.0).

Para ajustar em que ponto da rolagem cada cena aparece, edite a lista `KEYFRAMES` em `background-scene.js` (seletor da seção, posição dentro dela e profundidade da câmera).

Os vídeos de vidro e metal e as fotografias anteriores são arquivos de trabalho e não são mais usados no fundo atual. A versão anterior da página está em `.background-backup/index-before-tech-scene.html`.

## Fundo anterior (vídeo)

A cena original do vídeo anterior está em `fonte-do-video/cena-escultura.html`, usando Three.js, materiais físicos e iluminação de estúdio. O navegador exibe o vídeo pronto, sem precisar renderizar 3D em tempo real.

```powershell
$env:SCENE='cena-escultura.html'
$env:SCENE_THEME='dark'
node fonte-do-video/render.mjs video glass-metal-dark-v3.mp4 24 10 2560 1440
$env:SCENE_THEME='light'
node fonte-do-video/render.mjs video glass-metal-light-v3.mp4 24 10 2560 1440
```

O renderizador usa Puppeteer ou Playwright via `PLAYWRIGHT_PATH`, Microsoft Edge e FFmpeg via `imageio-ffmpeg`. `fonte-do-video/check-background.cjs` verifica os dois temas, a navegação pelo vídeo e a presença do crachá no layout móvel. As telas das ferramentas contêm dados fictícios.

As matrizes 1440p são convertidas para 1080p com FFmpeg: `-vf scale=1920:1080 -c:v libx264 -preset fast -crf 24 -g 1 -bf 0 -an -movflags +faststart`.
