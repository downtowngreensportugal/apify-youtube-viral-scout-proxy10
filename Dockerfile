FROM apify/actor-node:18
WORKDIR /usr/src/app
COPY package.json ./package.json
COPY actor.json ./actor.json
COPY README.md ./README.md
COPY index.js ./index.js
RUN npm ci --omit=dev --no-audit --no-fund || npm install --only=prod --no-audit --no-fund
CMD ["node","index.js"]
