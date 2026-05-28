# Architecture — DonnerSang

## Vue d'ensemble

DonnerSang est une application **single-page** (SPA) sans framework ni dépendance externe. Tout le code est en HTML, CSS et JavaScript vanille. Les sources sont maintenues dans `src/` et assemblées en un unique `index.html` par le script `build.sh`.

```
src/
├── index.html   # Structure HTML (188 lignes)
├── style.css    # Styles et thèmes (820 lignes)
└── app.js       # Logique applicative (1 512 lignes)
        │
        ▼ build.sh
index.html       # Fichier assemblé déployé sur GitHub Pages
```

---

## Structure HTML (`src/index.html`)

La page est organisée en quatre blocs verticaux dans l'ordre du DOM :

```
<header>              # Barre d'accessibilité + titre
<div #assistant-panel> # Panneau assistant vocal (masqué par défaut)
<main>
  <section #recherche>  # Formulaire : adresse, filtres, rayon, dates
  <section #resultats>  # Résultats dynamiques injectés par JS
<footer>              # Crédits EFS et lien RGAA
```

**Points notables :**
- Un `<a class="skip-link">` en tout premier élément du `<body>` permet aux lecteurs d'écran de sauter directement aux résultats.
- Le panneau assistant (`#assistant-panel`) est rendu avec `hidden` et n'apparaît que lorsque l'assistant est actif.
- La section `#resultats` porte `aria-live="polite"` : les lecteurs d'écran annoncent automatiquement les nouveaux résultats sans action de l'utilisateur.
- Les icônes sont toutes en `aria-hidden="true"` pour ne pas être vocalisées.

---

## Architecture CSS (`src/style.css`)

### Variables CSS

Toutes les couleurs, espacements et tailles sont définis en variables CSS dans `:root`. Cela permet de surcharger l'intégralité du thème en changeant uniquement ce bloc.

```css
:root {
  --rouge, --rouge-fonce, --rouge-clair   /* sang */
  --plasma, --plasma-clair                /* plasma */
  --plaquette, --plaquette-clair          /* plaquettes */
  --texte, --texte-sec, --fond, --blanc   /* neutres */
  --bordure, --focus, --success           /* états */
  --rayon, --ombre, --taille-base         /* géométrie */
}
```

### Thèmes adaptatifs

Trois mécanismes de thème coexistent :

| Mécanisme | Déclencheur | Ce qu'il modifie |
|-----------|-------------|-----------------|
| `prefers-color-scheme: dark` | Préférence OS | Couleurs de fond et texte |
| `prefers-contrast: more` | Préférence OS | Contrastes renforcés |
| `body.contraste-eleve` | Bouton dans l'UI | Surcharge manuelle des variables |
| `body.grand-texte` | Bouton dans l'UI | `font-size: 21px` sur `body` |

### Responsive

Deux breakpoints principaux :
- `≤ 600px` : les boutons adresse/micro/géoloc passent sur deux lignes (input pleine largeur, boutons 50/50).
- `≤ 480px` : réduction de la taille du titre et des filtres.

Safe-area iOS (notch, barre de navigation) gérée via `env(safe-area-inset-*)` sur `header`, `footer`, `#recherche` et `#resultats`.

### Autocomplétion

La liste `#autocomplete-list` est en `position: fixed` (coordonnées recalculées par JS) pour ne jamais être découpée par un parent `overflow: hidden`. Un backdrop transparent `#ac-backdrop` couvre toute la fenêtre quand la liste est ouverte, pour capturer les clics extérieurs.

---

## Architecture JavaScript (`src/app.js`)

Tout le code est encapsulé dans une **IIFE** `(function () { "use strict"; ... })()` pour éviter toute pollution du scope global.

### État global

```js
let lat = null, lng = null   // coordonnées du point de recherche
let villeNom = null          // nom de ville (pour l'API EFS searchbycityname)
let suggestions = []         // suggestions d'autocomplétion en cours
let selectedIndex = -1       // index clavier dans la liste autocomplete
let autocompleteTimer = null // timer de debounce
```

### Modules fonctionnels

Le code est découpé en sections commentées, dans l'ordre d'exécution naturel :

```
CONSTANTES          → URLs des APIs, délai debounce
ÉTAT GLOBAL         → lat/lng/villeNom, autocomplete
UTILITAIRES         → $(), formatDateFR(), kmStr(), esc()…
DATES               → initialisation date-debut / date-fin au chargement
SLIDER RAYON        → mise à jour aria-valuetext en temps réel
ACCESSIBILITÉ       → toggle grand-texte / contraste-eleve
SPEECH-TO-TEXT      → reconnaissance vocale du champ adresse
SPEECH SYNTHESIS    → lecture vocale des cartes de résultats
GÉOLOCALISATION     → bouton "Ma position" + reverse geocoding
AUTOCOMPLETE        → debounce → BAN API → rendu liste → sélection
GÉOCODAGE TEXTE     → fallback si aucune suggestion sélectionnée
API EFS             → construction de l'URL et appel fetch
RENDU PERMANENT     → génération HTML d'une carte site permanent
RENDU COLLECTE      → génération HTML d'une carte collecte mobile
RECHERCHE           → orchestration principale (validation → géocode → EFS → rendu)
MESSAGES            → showMsg() / hideMsg()
ASSISTANT VOCAL     → machine à états (IIFE imbriquée)
LISTENERS GLOBAUX   → btn-rechercher, Entrée sur le champ
```

### Flux de données principal

```
Utilisateur saisit une adresse
        │
        ▼
Debounce 280ms → BAN /search → liste de suggestions
        │
        ▼ (sélection ou Entrée)
lat/lng/villeNom mis à jour
        │
        ▼
btn-rechercher → rechercher()
        │
        ├─ villeNom présent → EFS /searchbycityname?cityName=…
        └─ coordonnées seules → EFS /searchnearpoint?Radius=…
                │
                ▼
        afficherResultats(data)
                │
                ├─ samplingLocationEntities_SF → renderPermanent() × N
                └─ samplingLocationCollections → renderCollecte() × N
                        │
                        ▼
                innerHTML injecté dans #liste-permanents / #liste-collectes
```

### Assistant vocal — machine à états

L'assistant est un **module isolé** (IIFE imbriquée) qui expose quatre méthodes : `startFlow`, `hide`, `quit`, `aide`.

Il maintient un état interne `aState` qui suit ce cycle :

```
idle
 │  "Bonjour Don"
 ▼
ask_loc ──────────────────────────────────┐
 │  adresse dictée                        │ "non"
 ▼                                        │
confirm_loc ──────────────────────────────┘
 │  "oui"
 ▼
searching
 │  fetchEFS() résolu
 ▼
results ◄──────────────────────────────────┐
 │  "détail N" / "suivant"                 │ "retour"
 ▼                                         │
detail ────────────────────────────────────┘
 │  "stop"
 ▼
[pause] ──► "reprise" ──► detail
```

**Deux recognizers parallèles** coexistent en état `detail` :
- `recogA` : écoute principale (question/réponse, états `ask_loc`, `confirm_loc`, `results`).
- `recogI` : écoute d'interruption en continu pendant le TTS, détecte les commandes sans attendre la fin de la lecture.

**Feedback audio** via Web Audio API : bip montant (660→880 Hz) avant l'écoute, bip descendant (880→440 Hz) à la fin.

**Workaround iOS Safari** : la synthèse vocale se met en pause après ~15 s. Un `setInterval` toutes les 5 s appelle `TTS.resume()` si `TTS.paused` est vrai.

### Rendu des cartes

Les fonctions `renderPermanent(item)` et `renderCollecte(item)` génèrent du HTML sous forme de chaînes et l'injectent via `innerHTML`. Toutes les valeurs issues de l'API passent par `esc()` (échappement HTML) avant insertion pour éviter les injections XSS.

Chaque carte reçoit un attribut `data-tts` contenant le texte à lire, généré par `texteCartePermanent()` ou `texteCarteCollecte()`. La lecture vocale lit directement ce champ sans retoucher le DOM.

---

## APIs externes

### EFS — `oudonner.api.efs.sante.fr/carto-api/v3`

Deux endpoints utilisés :

| Endpoint | Paramètres clés | Cas d'usage |
|----------|----------------|-------------|
| `/samplingcollection/searchbycityname` | `cityName`, `GiveBlood`, `GivePlasma`, `GivePlatelet`, `StartDate`, `EndDate` | Quand une ville est identifiée (plus fiable) |
| `/samplingcollection/searchnearpoint` | `UserLatitude`, `UserLongitude`, `Radius` | Fallback coordonnées GPS seules |

La réponse contient deux tableaux :
- `samplingLocationEntities_SF` → sites permanents
- `samplingLocationCollections` → collectes mobiles (avec sous-tableau `collections[]` par séance)

### BAN — `api-adresse.data.gouv.fr`

| Endpoint | Usage |
|----------|-------|
| `/search?q=…&limit=6&autocomplete=1` | Suggestions en temps réel |
| `/search?q=…&limit=1` | Géocodage texte libre |
| `/reverse?lon=…&lat=…` | Coordonnées GPS → nom de ville |

---

## Système de build

`build.sh` est un script Python (shebang `#!/usr/bin/env python3`) qui :
1. Lit `src/index.html`
2. Remplace `<link rel="stylesheet" href="style.css">` par le contenu de `src/style.css` encadré de balises `<style>`
3. Remplace `<script src="app.js" defer></script>` par le contenu de `src/app.js` encadré de balises `<script>`
4. Écrit le résultat dans `index.html` à la racine

```
src/index.html ──┐
src/style.css  ──┤ build.sh ──► index.html  (90 Ko, zéro requête externe)
src/app.js     ──┘
```

Le fichier `index.html` généré est le seul artefact déployé. Il est auto-suffisant : une seule requête HTTP suffit à charger l'intégralité de l'application.

---

## Pipeline de déploiement

```
git push master
      │
      ▼
GitHub Actions (.github/workflows/deploy.yml)
      │
      ├─ actions/checkout@v4
      ├─ python3 build.sh          ← assemble index.html
      ├─ actions/configure-pages@v5
      ├─ actions/upload-pages-artifact@v3  (path: .)
      └─ actions/deploy-pages@v4
              │
              ▼
      https://bzhdha.github.io/fastDDS/
```
