# DonnerSang 🩸

Application web pour trouver facilement les prochaines collectes de sang, plasma et plaquettes de l'EFS (Établissement Français du Sang) près de chez soi.

---

## Fonctionnalités

### Recherche

**Saisie d'adresse avec autocomplétion**
Le champ de recherche propose des suggestions en temps réel dès le deuxième caractère saisi, via l'API adresse.data.gouv.fr. La navigation clavier (flèches, Entrée, Échap) est entièrement supportée.

**Géolocalisation GPS**
Le bouton « Ma position » récupère les coordonnées GPS de l'appareil et identifie automatiquement la ville correspondante par reverse geocoding.

**Dictée vocale de l'adresse**
Le bouton 🎤 permet de dicter l'adresse à voix haute. La transcription est convertie en suggestions d'adresse automatiquement. Un bip sonore indique le début et la fin de l'écoute.

**Filtres de recherche**
- Type de don : sang total, plasma, plaquettes (cases à cocher combinables)
- Période : date de début et date de fin
- Rayon : curseur de 5 à 100 km

---

### Résultats

**Maisons du don et sites permanents**
Affichés en premier, triés par distance. Chaque carte contient :
- Nom et adresse complète
- Distance depuis le point de recherche
- Types de dons acceptés (badges colorés)
- Horaires d'ouverture
- Accès transports (métro, bus, tram) et parking
- Bouton de prise de RDV (par type de don si plusieurs disponibles)
- Lien itinéraire Google Maps
- Numéro de téléphone cliquable

**Collectes mobiles**
Affichées ensuite, triées par date de prochaine session puis par distance. Chaque carte contient :
- Nom du lieu et adresse
- Liste des séances avec date, horaires matin/après-midi et type de collecte
- Bouton de RDV par séance
- Lien itinéraire Google Maps

---

### Lecture vocale des résultats

**Lecture globale**
Le bandeau « Lire les résultats » lit à voix haute l'ensemble des résultats en séquence : introduction avec le nombre de sites, puis détail de chaque fiche. La carte en cours de lecture est mise en surbrillance et scrollée dans la vue.

**Lecture individuelle**
Chaque carte dispose d'un bouton 🔊 pour lire uniquement sa fiche. Un clic sur le même bouton en cours de lecture arrête la synthèse.

---

### Assistant vocal « Bonjour Don »

Accessible en cliquant sur 🎤 puis en disant « Bonjour Don ». Permet de piloter l'intégralité de la recherche et de la navigation sans toucher l'écran.

**Déroulement**
1. L'assistant demande la ville ou l'adresse (ou « ma position » pour le GPS)
2. Il confirme l'adresse trouvée et attend « oui » ou « non »
3. Il lance la recherche et annonce les résultats (nombre de sites, noms, distances)
4. Navigation libre entre les fiches par commandes vocales

**Commandes disponibles**

| Commande | Action |
|----------|--------|
| `Bonjour Don` | Démarrer l'assistant |
| `Ma position` | Utiliser le GPS |
| `Oui` | Confirmer l'adresse |
| `Non` | Changer d'adresse |
| `Lieu suivant` / `Suivant` | Fiche suivante |
| `Lieu précédent` | Fiche précédente |
| `Détail 1` | Lire la fiche numéro 1 |
| `Détail [nom]` | Lire la fiche dont le nom correspond |
| `RDV` | Ouvrir la page de rendez-vous |
| `Stop` | Interrompre la lecture en cours |
| `Reprise` | Relire la fiche depuis le début |
| `Retour` | Revenir à la liste des résultats |
| `Aide Don` | Énoncer l'aide complète |
| `Au revoir Don` | Quitter l'assistant |
| `Calibration Don` | Tester la reconnaissance du micro |

**Interruption en temps réel**
Pendant la lecture d'une fiche, l'assistant écoute en continu les commandes d'interruption (suivant, précédent, stop, RDV…) sans attendre la fin du texte.

---

### Accessibilité

- **Grand texte** : augmente la taille de police sur toute la page
- **Contraste élevé** : renforce les couleurs pour une meilleure lisibilité
- **Skip-link** : lien d'évitement vers les résultats pour les lecteurs d'écran
- **Navigation clavier** complète (Tab, flèches, Entrée, Échap)
- **Zones ARIA** : `aria-live`, `aria-label`, `role` sur tous les éléments interactifs
- **Responsive mobile** : mise en page adaptée, support du safe-area iPhone (notch)
- **Reduced motion** : animations désactivées si l'utilisateur le demande dans son OS
- **Mode sombre** : s'adapte automatiquement aux préférences système

---

## Architecture technique

Application **zéro dépendance**, construite en HTML, CSS et JavaScript vanille.

```
src/
├── index.html   # Structure HTML (188 lignes)
├── style.css    # Mise en page et thèmes (820 lignes)
└── app.js       # Logique applicative (1 512 lignes)
```

`build.sh` assemble ces trois fichiers en un unique `index.html` prêt à déployer.

### APIs utilisées

| API | Rôle |
|-----|------|
| `oudonner.api.efs.sante.fr/carto-api/v3` | Données des collectes EFS |
| `api-adresse.data.gouv.fr/search` | Autocomplétion et géocodage |
| `api-adresse.data.gouv.fr/reverse` | Coordonnées GPS → ville |
| Web Speech API — SpeechRecognition | Dictée vocale et assistant |
| Web Speech API — SpeechSynthesis | Lecture des résultats |
| Web Audio API | Bips de feedback de l'assistant |

### Compatibilité navigateurs

| Navigateur | Recherche | Lecture vocale | Assistant vocal |
|------------|-----------|---------------|-----------------|
| Chrome / Edge | ✅ | ✅ | ✅ |
| Safari iOS 14.5+ (HTTPS) | ✅ | ✅ | ✅ partiel |
| Firefox | ✅ | ✅ | ❌ (STT absent) |

---

## Lancer en local

```bash
./dev.sh          # build + serveur sur http://localhost:8080
./dev.sh 3000     # port personnalisé
```

## Déploiement

Chaque push sur `master` déclenche le workflow GitHub Actions qui build et publie sur GitHub Pages.

---

## Données

Données issues de l'EFS — [data.gouv.fr](https://www.data.gouv.fr/datasets/lieux-et-horaires-des-collectes-de-sang) — Licence Ouverte 2.0.
