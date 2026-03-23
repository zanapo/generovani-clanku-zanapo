# Generovani Clanku + Web Description

Node.js aplikace pro:
- generovani clanku (topic ideas + AI pipeline),
- generovani produktovych popisku CZ/SK (vcetne SQL),
- bulk CSV import a hromadne generovani popisku.

## Pozadavky

- Node.js 20+
- Docker + Docker Compose
- OpenAI API klic

## Rychly start (Coder)

1) Naklonuj repo a prejdi do slozky:

```bash
git clone https://github.com/zanapo/generovani-clanku-zanapo.git
cd generovani-clanku-zanapo
```

2) Nainstaluj zavislosti:

```bash
npm install
```

3) Vytvor `.env` z ukazky:

```bash
cp .env.example .env
```

4) Vypln minimalne:
- `OPENAI_API_KEY`

5) Spust databaze:

```bash
docker compose up -d
```

6) Vygeneruj Prisma klienta a aplikuj migrace:

```bash
npm run prisma:gen
npx prisma migrate deploy
```

7) Spust API:

```bash
PORT=3010 npm run dev
```

8) (Doporucene) Spust worker pro article pipeline:

```bash
npm run worker
```

## URL

- Dashboard: `http://localhost:3010/`
- Article app: `http://localhost:3010/index.html`
- Web Description app: `http://localhost:3010/web-description.html`

## Bulk CSV workflow (Web Description)

1) Otevri `web-description.html`
2) V sekci **Hromadne generovani z CSV** nahraj CSV
3) Klikni **Importovat CSV**
4) Klikni **Vygenerovat vse (pripravene)**
5) Klikni na radek produktu pro detail:
- CZ/SK HTML,
- CZ/SK SQL,
- tokeny a cena za polozku.

## Poznamky

- Repo neobsahuje `.env` (je v `.gitignore`).
- `docker-compose.yml` mapuje Postgres na `localhost:5433`.
- Google Ads / Google Search klíce jsou volitelne (bez nich pobezi jadro aplikace, jen bez nekterych enrichment funkci).
