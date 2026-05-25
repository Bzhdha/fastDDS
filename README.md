# DonnerSang 🩸

Application web pour trouver facilement les prochaines collectes de sang, plasma et plaquettes de l'EFS (Établissement Français du Sang) près de chez soi.

## Fonctionnalités

- **Recherche par adresse** avec autocomplete (API BAN / adresse.data.gouv.fr)
- **Géolocalisation GPS** avec reverse geocoding
- **Filtres** par type de don (sang, plasma, plaquettes) et par période/rayon
- **Résultats** : maisons du don permanentes + collectes mobiles, triés par distance
- **Liens directs** : prise de RDV, itinéraire Google Maps, téléphone
- **Reconnaissance vocale** (Speech-to-Text) pour dicter l'adresse
- **Synthèse vocale** (Text-to-Speech) pour lire les résultats
- **Assistant vocal complet** déclenché par « Bonjour Don » :
  - Navigation entre les lieux par la voix
  - Interruption de lecture en temps réel
  - Calibration vocale
- **Accessibilité RGAA** : grand texte, contraste élevé, skip-link, aria-live, focus visible

## Architecture

Application **zéro dépendance**, tout-en-un dans `index.html` (HTML + CSS + JS vanille).

### APIs utilisées

| API | Rôle |
|-----|------|
| `oudonner.api.efs.sante.fr/carto-api/v3` | Données des collectes (sites permanents + mobiles) |
| `api-adresse.data.gouv.fr/search` | Autocomplete et géocodage d'adresses |
| `api-adresse.data.gouv.fr/reverse` | Reverse geocoding (coordonnées → ville) |
| Web Speech API (SpeechRecognition) | Dictée vocale et assistant |
| Web Speech API (SpeechSynthesis) | Lecture des résultats |

### Compatibilité vocale

- **Chrome / Edge** : complète (STT + TTS + assistant)
- **Safari iOS 14.5+** : support partiel (HTTPS requis en production, workaround TTS pause)
- **Firefox** : TTS uniquement (STT non supporté)

## Utilisation

Ouvrir `index.html` directement dans un navigateur. Aucun serveur ni build requis.

Pour la géolocalisation et la reconnaissance vocale en production, le site doit être servi en **HTTPS**.

## Commandes de l'assistant vocal

| Commande | Action |
|----------|--------|
| `Bonjour Don` | Démarrer l'assistant |
| `Ma position` | Utiliser le GPS |
| `Détail 1` / `Détail [nom]` | Lire le détail d'un lieu |
| `Lieu suivant` / `Suivant` | Lieu suivant |
| `Lieu précédent` | Lieu précédent |
| `RDV` | Ouvrir la page de rendez-vous |
| `Stop` | Interrompre la lecture |
| `Retour` | Retourner à la liste |
| `Aide Don` | Aide vocale complète |
| `Au revoir Don` | Quitter l'assistant |
| `Calibration Don` | Tester / calibrer le micro |

## Données

Données issues de l'EFS — [data.gouv.fr](https://www.data.gouv.fr/datasets/lieux-et-horaires-des-collectes-de-sang) — Licence Ouverte 2.0.
