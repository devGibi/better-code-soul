# Better Code Soul

OpenCode icin paralel subagent orkestrasyon, token takibi, Graphify ve Context Mode yonetimi plugini.

## Kurulum

```bash
npm install -g better-code-soul
better-code-soul setup
# OpenCode'u yeniden baslatin
/bcs-status
```

## Komutlar

| Komut | Aciklama |
|-------|----------|
| `/bcs-status` | Genel durum ozeti — token, maliyet, aktif araclar |
| `/bcs-tokens [donem]` | Token ve maliyet raporu (session, today, week, month) |
| `/bcs-models` | Kullanilabilir modeller, auth durumu ve fiyat karsilastirmasi |
| `/bcs-agent "gorev"` | Paralel subagent orkestrasyon |
| `/bcs-graphify` | Graphify hafiza sistemi yonetimi |
| `/bcs-context-mode` | Context Mode token tasarrufu yonetimi |
| `/bcs-optimize` | Token optimizasyon onerileri |

## Paralel Subagent Orkestrasyon Nasil Calisir?

```
Geleneksel yaklasim (yavas):
  Kullanici: "Kullanici profil sayfasi ekle"
  → Tek model (Opus, $15/1M) tum isi yapar
  → Planlama + kod + test + review = tek context, sirayla
  → Sure: 15 dk · Maliyet: $0.45

Better Code Soul yaklasimi (hizli):
  Kullanici: "Kullanici profil sayfasi ekle"
  → Orchestrator gorevi analiz eder
  → PlannerAgent (Gemini Pro, $1.25/1M) → mimari plan → 2 dk
  → Paralel baslar:
       CoderAgent A (Kimi K2, $0.60/1M) → ProfileCard component → 3 dk
       CoderAgent B (Kimi K2, $0.60/1M) → API endpoint → 3 dk
       CoderAgent C (DeepSeek V3, $0.27/1M) → DB migration → 3 dk
  → ReviewerAgent (Haiku, $0.80/1M) → dogrulama → 1 dk
  → ResultMerger → birlestir + cakisma coz
  → Sure: 4 dk (paralel) · Maliyet: $0.06

Tasarruf: %87 maliyet, %73 sure
```

## Graphify

Graphify proje kodunuzdan bir bilgi grafiği olusturur. Model tum dosyalari okumak yerine grafigi sorgular.

```bash
/bcs-graphify install   # Graphify'yi kur
/bcs-graphify build     # Mevcut proje icin graf olustur
/bcs-graphify enable    # Bu projede aktiflesdir
```

## Context Mode

Context Mode tool ciktilarini model context'ine girmeden once ozetler.
Bu, tool output token'larinin yaklasik %98'ini tasarruf eder.

```bash
/bcs-context-mode install   # Global kur
/bcs-context-mode enable    # Bu projede aktiflesdir
/bcs-context-mode stats     # Tasarruf goruntule
```

## MCP Server

Better Code Soul ayni zamanda bir MCP server olarak calisir:

```bash
better-code-soul mcp
```

Bu tum araclari Model Context Protocol (stdio transport) uzerinden sunar.

## Gereksinimler

- Node.js 18+
- OpenCode yuklu olmali

## Lisans

MIT
