---
name: RecallRelay
description: Calm, exact payment operations for product recalls.
colors:
  bg: "#ffffff"
  bg-subtle: "#f6f8fa"
  border: "#e3e8ee"
  border-soft: "#ebeef1"
  text: "#1a1f36"
  text-2: "#4f566b"
  text-3: "#697386"
  primary: "#4a4fe0"
  primary-hover: "#3d41c7"
  primary-tint: "#eef0ff"
  success: "#0e6245"
  success-fill: "#d7f7e0"
  warning: "#983705"
  warning-fill: "#fcedb9"
  danger: "#b3093c"
  danger-fill: "#ffe3ea"
  info: "#0a5bc4"
  info-fill: "#dfedff"
  neutral: "#4f566b"
  neutral-fill: "#ebeef1"
typography:
  page-title:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: "32px"
    letterSpacing: "-0.025em"
  section-title:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "24px"
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
    fontFeature: "cv11, ss03"
  small:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "13px"
    lineHeight: "18px"
  caption:
    fontFamily: "Inter Variable, Inter, sans-serif"
    fontSize: "12px"
    lineHeight: "16px"
  reference:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
rounded:
  badge: "4px"
  control: "6px"
  card: "8px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "24px"
  xxxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.bg}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
    height: "32px"
  button-secondary:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
    height: "32px"
  card:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
    padding: "20px"
  badge-success:
    backgroundColor: "{colors.success-fill}"
    textColor: "{colors.success}"
    rounded: "{rounded.badge}"
    height: "20px"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    height: "32px"
---

# Design System: RecallRelay

## Overview

**Creative North Star: "The Clear Settlement Desk"**

RecallRelay is a working payments dashboard for merchants handling a safety recall. White work surfaces, a quiet cool sidebar, a compact type scale, and an explicit warning strip make status and action easy to find. The refund timeline is the one distinctive visual move: it turns a deadline into a readable order of work while keeping the same restrained component system.

The system is exact and calm. It treats a hazard plainly, exposes simulated and sandbox state, and places evidence beside financial decisions. The rejected case-file styling is not part of this system.

**Key Characteristics:**

- Dense, aligned data tables and compact controls.
- Soft state fills with words and icons where useful.
- A deliberate approval card next to the order table.
- Consistent merchant shell and checkout-like buyer flow.

## Colors

The palette is a white canvas with cool neutral structure, one indigo action color, and semantic colors for money and safety state.

### Primary

- **Action indigo:** Buttons, links, selected navigation, focus, and the timeline today marker use `primary`; hover uses `primary-hover`, while selected fills use `primary-tint`.

### Status

- **Success green:** Completed and refunded states pair `success` text with `success-fill`.
- **Warning amber:** Waiting and buyer-choice states pair `warning` text with `warning-fill`; the sandbox strip uses the same pair.
- **Danger rose:** Hazards, urgent deadlines, and human review pair `danger` text with `danger-fill`.
- **Information blue:** Payout and real-sandbox badges pair `info` text with `info-fill`.

### Neutral

- **Work surface:** `bg` keeps pages and cards white; `bg-subtle` separates the rail, hover rows, and read-only areas.
- **Text ladder:** `text` carries primary information, `text-2` explanations, and `text-3` captions and table headers.
- **Quiet rules:** `border` outlines cards and controls; `border-soft` separates table rows. `neutral` on `neutral-fill` marks no-action states and IDs.

**The Meaningful Color Rule.** A status color always has a visible word. Danger is reserved for hazards, urgent work, or review, never general decoration.

## Typography

Inter Variable is used throughout the merchant and buyer interfaces, including official notice text. OpenType features `cv11` and `ss03` are enabled globally. Numerals are tabular; amounts stay in Inter, while order IDs, references, and hashes use the 12 px system monospace stack.

### Hierarchy

- **Page title:** 24 px / 32 px at weight 600.
- **Section title:** 16 px / 24 px at weight 600.
- **Body:** 14 px / 20 px at weight 400.
- **Small:** 13 px / 18 px for supporting labels.
- **Caption:** 12 px / 16 px for metadata and table headers.

**The Financial Numeral Rule.** Keep currency symbols, amounts, and ISO currency codes together and aligned with tabular numerals. Never imply a cross-currency total.

## Layout

The desktop shell has a 28 px sandbox strip, a 232 px sidebar, and a 56 px top bar. Merchant content sits inside a left-aligned region capped at 1240 px with 32 px padding. The common grids place primary work at left and a smaller source, approval, or invoice card at right; tables sit directly on the page without an outer card.

Spacing follows a 4 px rhythm. The shell narrows at 800 px, with some multi-column work areas stacking; at 600 px navigation becomes a compact horizontal row. Buyer pages use a centered column capped at 480 px and a full-width primary action.

**The Decision Adjacency Rule.** Place the plan's budget and approval beside the order table so every proposed money movement is in view at the decision point.

## Elevation & Depth

Cards are flat white surfaces distinguished by a 1 px border. Buttons and small menus use the shared low offset shadow (`0 1px 1px rgba(0,0,0,.08), 0 2px 5px rgba(60,66,87,.08)`). There are no gradients or glass surfaces. Focus uses a 3 px indigo ring at 25% opacity.

**The Flat Surface Rule.** Use borders and spacing to structure work; reserve shadows for controls and overlays.

## Shapes

Controls use 6 px corners, cards use 8 px, and badges use 4 px. The rail mark is a 28 px rounded square and the merchant avatar is round. Soft timeline bars use 4 px corners without dark outlines.

## Components

### Buttons

Primary buttons are 32 px tall with an indigo fill, white 14 px medium text, and the shared shadow. Secondary buttons are white with a neutral border. Disabled buttons have 50% opacity and no shadow; loading shows a spinner inside the button. Hover darkens primary and softens secondary; keyboard focus is visible.

### Badges

Badges are 20 px tall, 12 px medium, sentence case, and natural width. They use a semantic foreground on a soft fill without a border. A 12 px Lucide icon may precede the word.

### Tables and filters

Table headers use 12 px muted text; rows use a 44 px minimum height and soft dividers. Hover adds the subtle page fill. Numeric amounts align right. Tabs use a 2 px indigo underline. Country and hazard filter controls use dashed borders and open a compact menu.

### Cards and fields

Cards have white fill, a quiet border, 8 px corners, and 20 px internal padding. Inputs are 32 px tall with 6 px corners and a visible indigo focus ring. Loading uses skeleton rows; empty and error states provide direct explanations.

### Navigation

The sidebar starts with the merchant mark and name, then 32 px icon-and-label links. The active route has a pale indigo fill and indigo text. The top bar holds a search field, help link, and merchant avatar. Lucide icons use one 1.75 stroke style.

### Refund timeline

Month columns and one row per order show deadline spans as soft colored bars. A 2 px indigo line marks today, with a small date pill. A separate AI suggestion card explains that AI only orders work; it never changes an action or amount.

## Do's and Don'ts

### Do:

- **Do** keep safety hazards explicit and visually prominent.
- **Do** show status in words alongside color and use visible keyboard focus.
- **Do** keep merchant data dense, aligned, and legible at 768 px.

### Don't:

- **Don't** revive beige paper, serif headings, stamps, double rules, or editorial case-file styling.
- **Don't** use gradients, glass, pure black fills, or Unicode glyphs as icons.
- **Don't** put amounts in monospace or add different currencies together.
