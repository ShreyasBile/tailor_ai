// Garment catalogue for the MVP: six fictional brands, their size charts and
// thirty-four products. Idempotent — re-running replaces the catalogue in place
// (recommendations and feedback referencing garments are kept by upserting on
// slug).
//
//   npm run db:seed            (from the repo root, with DATABASE_URL set)
//
// Size charts are *body* measurement ranges per size, which is what brands
// publish and what the fit engine expects. Shoulder is biacromial breadth and
// arm is acromion-to-wrist — body dimensions, not garment shoulder seam or
// sleeve length. Ranges are realistic but invented;
// each brand runs slightly differently on purpose, so the same body gets
// different sizes across brands — the point of the product.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Product photos made by scripts/make-product-photos.py, served by the web app.
const PHOTOS = fileURLToPath(new URL('../../web/public/garments/', import.meta.url));
const photoFor = (slug) => (existsSync(`${PHOTOS}${slug}.jpg`) ? `/garments/${slug}.jpg` : null);

const BRANDS = [
  {
    slug: 'northline',
    name: 'Northline',
    description: 'Clean-cut everyday essentials. Runs true to size.',
    accentHex: '#1f3a5f',
  },
  {
    slug: 'atelier-nove',
    name: 'Atelier Nove',
    description: 'Tailored pieces with a close, European cut. Runs small.',
    accentHex: '#7a4b3a',
  },
  {
    slug: 'denim-theory',
    name: 'Denim Theory',
    description: 'Denim and chinos, sized by waist and inseam.',
    accentHex: '#2c4a6b',
  },
  {
    slug: 'kinfolk',
    name: 'Kinfolk',
    description: 'Relaxed, generous basics for every body. Runs large.',
    accentHex: '#5b6b4a',
  },
  {
    slug: 'desi-loom',
    name: 'Desi Loom',
    description: 'Handloom kurtas and ethnic wear, cut to Indian sizing.',
    accentHex: '#a0522d',
  },
  {
    slug: 'stride',
    name: 'Stride',
    description: 'Athleisure in performance stretch fabrics. Runs true to size.',
    accentHex: '#2f5d50',
  },
];

// chart name → { brand, category, sizes: [label, { dim: [min, max] }] }
const CHARTS = {
  'northline-mens-tops': {
    brand: 'northline',
    category: 'TOPS',
    sizes: [
      ['XS', { chest: [82, 88], waist: [68, 74], shoulder_width: [36, 38], neck: [35, 37], arm_length: [55, 57] }],
      ['S', { chest: [88, 94], waist: [74, 80], shoulder_width: [38, 40], neck: [37, 39], arm_length: [57, 59] }],
      ['M', { chest: [94, 102], waist: [80, 88], shoulder_width: [40, 42], neck: [39, 41], arm_length: [59, 61] }],
      ['L', { chest: [102, 110], waist: [88, 96], shoulder_width: [42, 44], neck: [41, 43], arm_length: [61, 63] }],
      ['XL', { chest: [110, 118], waist: [96, 104], shoulder_width: [44, 46], neck: [43, 45], arm_length: [62, 64] }],
      ['XXL', { chest: [118, 128], waist: [104, 114], shoulder_width: [46, 48], neck: [45, 47], arm_length: [63, 65] }],
    ],
  },
  'northline-womens-tops': {
    brand: 'northline',
    category: 'TOPS',
    sizes: [
      ['XS', { chest: [78, 82], waist: [60, 64], shoulder_width: [33, 34.5] }],
      ['S', { chest: [82, 87], waist: [64, 69], shoulder_width: [34.5, 36] }],
      ['M', { chest: [87, 93], waist: [69, 75], shoulder_width: [36, 37.5] }],
      ['L', { chest: [93, 100], waist: [75, 82], shoulder_width: [37.5, 39] }],
      ['XL', { chest: [100, 108], waist: [82, 90], shoulder_width: [39, 41] }],
    ],
  },
  'northline-outerwear': {
    brand: 'northline',
    category: 'OUTERWEAR',
    sizes: [
      ['S', { chest: [88, 95], waist: [74, 82], shoulder_width: [38, 41], arm_length: [56, 59] }],
      ['M', { chest: [95, 103], waist: [82, 90], shoulder_width: [40, 43], arm_length: [58, 61] }],
      ['L', { chest: [103, 111], waist: [90, 98], shoulder_width: [42, 45], arm_length: [60, 63] }],
      ['XL', { chest: [111, 120], waist: [98, 107], shoulder_width: [44, 47], arm_length: [62, 65] }],
    ],
  },
  'atelier-nove-shirts': {
    brand: 'atelier-nove',
    category: 'TOPS',
    sizes: [
      ['44', { chest: [84, 89], waist: [70, 75], shoulder_width: [37, 38.5], neck: [36, 38], arm_length: [56, 58] }],
      ['46', { chest: [89, 94], waist: [75, 80], shoulder_width: [38.5, 40], neck: [38, 39.5], arm_length: [57, 59] }],
      ['48', { chest: [94, 99], waist: [80, 85], shoulder_width: [40, 41.5], neck: [39.5, 41], arm_length: [58, 60] }],
      ['50', { chest: [99, 104], waist: [85, 90], shoulder_width: [41.5, 43], neck: [41, 42.5], arm_length: [59, 61] }],
      ['52', { chest: [104, 109], waist: [90, 96], shoulder_width: [43, 44.5], neck: [42.5, 44], arm_length: [60, 62] }],
      ['54', { chest: [109, 115], waist: [96, 102], shoulder_width: [44.5, 46], neck: [44, 45.5], arm_length: [61, 63] }],
    ],
  },
  'atelier-nove-dresses': {
    brand: 'atelier-nove',
    category: 'DRESSES',
    sizes: [
      ['34', { chest: [78, 82], waist: [60, 64], hip: [86, 90] }],
      ['36', { chest: [82, 86], waist: [64, 68], hip: [90, 94] }],
      ['38', { chest: [86, 90], waist: [68, 72], hip: [94, 98] }],
      ['40', { chest: [90, 95], waist: [72, 77], hip: [98, 103] }],
      ['42', { chest: [95, 100], waist: [77, 82], hip: [103, 108] }],
      ['44', { chest: [100, 106], waist: [82, 88], hip: [108, 114] }],
    ],
  },
  'denim-theory-jeans': {
    brand: 'denim-theory',
    category: 'BOTTOMS',
    sizes: [
      ['28', { waist: [70, 74], hip: [88, 92], inseam: [76, 82], thigh: [52, 55] }],
      ['30', { waist: [74, 79], hip: [92, 97], inseam: [77, 83], thigh: [54, 57] }],
      ['32', { waist: [79, 84], hip: [97, 102], inseam: [78, 84], thigh: [56, 59] }],
      ['34', { waist: [84, 89], hip: [102, 107], inseam: [79, 85], thigh: [58, 61] }],
      ['36', { waist: [89, 95], hip: [107, 112], inseam: [79, 85], thigh: [60, 64] }],
      ['38', { waist: [95, 101], hip: [112, 118], inseam: [79, 85], thigh: [63, 67] }],
    ],
  },
  'denim-theory-womens': {
    brand: 'denim-theory',
    category: 'BOTTOMS',
    sizes: [
      ['24', { waist: [60, 63], hip: [86, 89], inseam: [74, 80] }],
      ['26', { waist: [63, 67], hip: [89, 93], inseam: [74, 80] }],
      ['28', { waist: [67, 71], hip: [93, 97], inseam: [75, 81] }],
      ['30', { waist: [71, 76], hip: [97, 102], inseam: [75, 81] }],
      ['32', { waist: [76, 81], hip: [102, 107], inseam: [75, 81] }],
      ['34', { waist: [81, 87], hip: [107, 113], inseam: [75, 81] }],
    ],
  },
  'kinfolk-unisex': {
    brand: 'kinfolk',
    category: 'TOPS',
    sizes: [
      ['XS', { chest: [80, 88], waist: [66, 76], shoulder_width: [36, 39] }],
      ['S', { chest: [88, 96], waist: [76, 84], shoulder_width: [39, 41.5] }],
      ['M', { chest: [96, 106], waist: [84, 94], shoulder_width: [41.5, 44] }],
      ['L', { chest: [106, 116], waist: [94, 104], shoulder_width: [44, 46.5] }],
      ['XL', { chest: [116, 126], waist: [104, 114], shoulder_width: [46.5, 49] }],
    ],
  },
  'kinfolk-bottoms': {
    brand: 'kinfolk',
    category: 'BOTTOMS',
    sizes: [
      ['S', { waist: [68, 78], hip: [88, 98], inseam: [74, 80] }],
      ['M', { waist: [78, 88], hip: [98, 106], inseam: [76, 82] }],
      ['L', { waist: [88, 98], hip: [106, 114], inseam: [77, 83] }],
      ['XL', { waist: [98, 110], hip: [114, 124], inseam: [77, 83] }],
    ],
  },
  'atelier-nove-blazers': {
    brand: 'atelier-nove',
    category: 'OUTERWEAR',
    sizes: [
      ['46', { chest: [88, 93], waist: [76, 81], shoulder_width: [39, 40.5], arm_length: [58, 60] }],
      ['48', { chest: [93, 98], waist: [81, 86], shoulder_width: [40.5, 42], arm_length: [59, 61] }],
      ['50', { chest: [98, 103], waist: [86, 91], shoulder_width: [42, 43.5], arm_length: [60, 62] }],
      ['52', { chest: [103, 108], waist: [91, 97], shoulder_width: [43.5, 45], arm_length: [61, 63] }],
      ['54', { chest: [108, 114], waist: [97, 103], shoulder_width: [45, 46.5], arm_length: [62, 64] }],
    ],
  },
  'atelier-nove-womens-blazers': {
    brand: 'atelier-nove',
    category: 'OUTERWEAR',
    sizes: [
      ['34', { chest: [80, 84], waist: [62, 66], shoulder_width: [35, 36], arm_length: [54, 56] }],
      ['36', { chest: [84, 88], waist: [66, 70], shoulder_width: [36, 37], arm_length: [55, 57] }],
      ['38', { chest: [88, 92], waist: [70, 74], shoulder_width: [37, 38], arm_length: [56, 58] }],
      ['40', { chest: [92, 97], waist: [74, 79], shoulder_width: [38, 39.5], arm_length: [57, 59] }],
      ['42', { chest: [97, 102], waist: [79, 84], shoulder_width: [39.5, 41], arm_length: [57, 59] }],
    ],
  },
  'northline-womens-skirts': {
    brand: 'northline',
    category: 'BOTTOMS',
    sizes: [
      ['XS', { waist: [60, 64], hip: [85, 89] }],
      ['S', { waist: [64, 69], hip: [89, 94] }],
      ['M', { waist: [69, 75], hip: [94, 100] }],
      ['L', { waist: [75, 82], hip: [100, 107] }],
      ['XL', { waist: [82, 90], hip: [107, 115] }],
    ],
  },
  'denim-theory-shorts': {
    brand: 'denim-theory',
    category: 'BOTTOMS',
    sizes: [
      ['28', { waist: [70, 74], hip: [88, 92], thigh: [52, 55] }],
      ['30', { waist: [74, 79], hip: [92, 97], thigh: [54, 57] }],
      ['32', { waist: [79, 84], hip: [97, 102], thigh: [56, 59] }],
      ['34', { waist: [84, 89], hip: [102, 107], thigh: [58, 61] }],
      ['36', { waist: [89, 95], hip: [107, 112], thigh: [60, 64] }],
    ],
  },
  'denim-theory-jackets': {
    brand: 'denim-theory',
    category: 'OUTERWEAR',
    sizes: [
      ['S', { chest: [86, 94], waist: [72, 80], shoulder_width: [38, 41], arm_length: [56, 59] }],
      ['M', { chest: [94, 102], waist: [80, 88], shoulder_width: [40, 43], arm_length: [58, 61] }],
      ['L', { chest: [102, 110], waist: [88, 96], shoulder_width: [42, 45], arm_length: [60, 63] }],
      ['XL', { chest: [110, 118], waist: [96, 105], shoulder_width: [44, 47], arm_length: [61, 64] }],
    ],
  },
  'kinfolk-dresses': {
    brand: 'kinfolk',
    category: 'DRESSES',
    sizes: [
      ['S', { chest: [80, 90], waist: [64, 76], hip: [88, 98] }],
      ['M', { chest: [90, 100], waist: [76, 88], hip: [98, 108] }],
      ['L', { chest: [100, 112], waist: [88, 100], hip: [108, 118] }],
      ['XL', { chest: [112, 124], waist: [100, 114], hip: [118, 130] }],
    ],
  },
  // Indian kurta sizes are labelled by chest in inches.
  'desi-loom-mens-kurtas': {
    brand: 'desi-loom',
    category: 'TOPS',
    sizes: [
      ['36', { chest: [87, 92], waist: [74, 80], shoulder_width: [39, 40.5], arm_length: [57, 59] }],
      ['38', { chest: [92, 97], waist: [80, 86], shoulder_width: [40.5, 42], arm_length: [58, 60] }],
      ['40', { chest: [97, 102], waist: [86, 92], shoulder_width: [42, 43.5], arm_length: [59, 61] }],
      ['42', { chest: [102, 107], waist: [92, 98], shoulder_width: [43.5, 45], arm_length: [60, 62] }],
      ['44', { chest: [107, 112], waist: [98, 104], shoulder_width: [45, 46.5], arm_length: [61, 63] }],
      ['46', { chest: [112, 117], waist: [104, 110], shoulder_width: [46.5, 48], arm_length: [62, 64] }],
    ],
  },
  'desi-loom-nehru-jackets': {
    brand: 'desi-loom',
    category: 'OUTERWEAR',
    sizes: [
      ['38', { chest: [92, 97], waist: [80, 86], shoulder_width: [40.5, 42] }],
      ['40', { chest: [97, 102], waist: [86, 92], shoulder_width: [42, 43.5] }],
      ['42', { chest: [102, 107], waist: [92, 98], shoulder_width: [43.5, 45] }],
      ['44', { chest: [107, 112], waist: [98, 104], shoulder_width: [45, 46.5] }],
    ],
  },
  'desi-loom-womens-kurtas': {
    brand: 'desi-loom',
    category: 'DRESSES',
    sizes: [
      ['XS', { chest: [78, 82], waist: [62, 66], hip: [86, 90] }],
      ['S', { chest: [82, 87], waist: [66, 71], hip: [90, 95] }],
      ['M', { chest: [87, 93], waist: [71, 77], hip: [95, 101] }],
      ['L', { chest: [93, 100], waist: [77, 84], hip: [101, 108] }],
      ['XL', { chest: [100, 108], waist: [84, 92], hip: [108, 116] }],
      ['XXL', { chest: [108, 116], waist: [92, 100], hip: [116, 124] }],
    ],
  },
  'stride-tops': {
    brand: 'stride',
    category: 'TOPS',
    sizes: [
      ['XS', { chest: [82, 88], waist: [66, 72], shoulder_width: [36, 38] }],
      ['S', { chest: [88, 94], waist: [72, 78], shoulder_width: [38, 40] }],
      ['M', { chest: [94, 100], waist: [78, 85], shoulder_width: [40, 42] }],
      ['L', { chest: [100, 107], waist: [85, 92], shoulder_width: [42, 44] }],
      ['XL', { chest: [107, 115], waist: [92, 100], shoulder_width: [44, 46] }],
    ],
  },
  'stride-bottoms': {
    brand: 'stride',
    category: 'BOTTOMS',
    sizes: [
      ['XS', { waist: [62, 68], hip: [84, 90], inseam: [72, 76] }],
      ['S', { waist: [68, 74], hip: [90, 96], inseam: [74, 78] }],
      ['M', { waist: [74, 81], hip: [96, 102], inseam: [76, 80] }],
      ['L', { waist: [81, 89], hip: [102, 109], inseam: [77, 81] }],
      ['XL', { waist: [89, 98], hip: [109, 117], inseam: [78, 82] }],
    ],
  },
};

const GARMENTS = [
  ['northline-oxford-shirt', 'Oxford Button-Down', 'northline-mens-tops', 'Shirts', 'men', 'REGULAR', 'NONE', '100% cotton oxford', 6900, 'Pale Blue', '#a9c4e0',
    'A crisp, breathable oxford with a soft button-down collar. Regular fit through the chest and waist.'],
  ['northline-essential-tee', 'Essential Crew Tee', 'northline-mens-tops', 'T-shirts', 'men', 'REGULAR', 'LOW', '100% organic cotton jersey', 2800, 'Heather Grey', '#9aa0a6',
    'The everyday tee, cut from mid-weight organic cotton that keeps its shape wash after wash.'],
  ['northline-merino-crew', 'Merino Crew Sweater', 'northline-mens-tops', 'Knitwear', 'men', 'SLIM', 'MEDIUM', '100% extra-fine merino', 11900, 'Navy', '#1f2a44',
    'Fine-gauge merino with a slim, close fit — layer it under a coat or wear it alone.'],
  ['northline-fitted-tee', 'Fitted Rib Tee', 'northline-womens-tops', 'T-shirts', 'women', 'SLIM', 'HIGH', '94% cotton, 6% elastane rib', 3200, 'Ivory', '#efe9dc',
    'A close-fitting ribbed tee with plenty of stretch. Designed to sit close to the body.'],
  ['northline-poplin-blouse', 'Poplin Blouse', 'northline-womens-tops', 'Shirts', 'women', 'RELAXED', 'NONE', '100% cotton poplin', 7400, 'White', '#f7f7f5',
    'A relaxed, slightly oversized poplin shirt with a dropped shoulder.'],
  ['northline-field-jacket', 'Field Jacket', 'northline-outerwear', 'Jackets', 'unisex', 'REGULAR', 'NONE', 'Waxed cotton canvas', 18900, 'Olive', '#5d6440',
    'A four-pocket waxed cotton jacket with room to layer a sweater underneath.'],
  ['northline-wool-overcoat', 'Wool Overcoat', 'northline-outerwear', 'Coats', 'unisex', 'RELAXED', 'NONE', '80% wool, 20% cashmere', 34900, 'Camel', '#b38b59',
    'A relaxed single-breasted overcoat in a soft wool–cashmere blend.'],
  ['atelier-nove-dress-shirt', 'Tailored Dress Shirt', 'atelier-nove-shirts', 'Shirts', 'men', 'SLIM', 'LOW', '100% two-ply cotton', 12900, 'White', '#fafafa',
    'A sharply tailored shirt with a spread collar. Slim European cut — sized by chest.'],
  ['atelier-nove-linen-shirt', 'Linen Camp Shirt', 'atelier-nove-shirts', 'Shirts', 'men', 'REGULAR', 'NONE', '100% European linen', 11500, 'Sand', '#d8c7a6',
    'A camp-collar linen shirt with a straight hem, made to be worn untucked.'],
  ['atelier-nove-wrap-dress', 'Silk Wrap Dress', 'atelier-nove-dresses', 'Dresses', 'women', 'REGULAR', 'LOW', '100% silk crepe', 24500, 'Burgundy', '#6e1f2f',
    'A fluid wrap dress in silk crepe, defined at the waist.'],
  ['atelier-nove-sheath-dress', 'Tailored Sheath Dress', 'atelier-nove-dresses', 'Dresses', 'women', 'SLIM', 'MEDIUM', 'Stretch wool crepe', 21900, 'Black', '#1a1a1a',
    'A close-fitting sheath in stretch wool crepe, fitted through the waist and hip.'],
  ['denim-theory-straight', 'Straight Selvedge Jean', 'denim-theory-jeans', 'Jeans', 'men', 'REGULAR', 'LOW', '13.5 oz selvedge denim, 1% elastane', 13800, 'Indigo', '#24324d',
    'A classic straight leg in rigid-feel selvedge denim with a touch of stretch.'],
  ['denim-theory-slim-chino', 'Slim Chino', 'denim-theory-jeans', 'Trousers', 'men', 'SLIM', 'MEDIUM', 'Cotton twill, 2% elastane', 8900, 'Khaki', '#bba77f',
    'A slim, tapered chino with enough stretch to move in.'],
  ['denim-theory-high-rise', 'High-Rise Wide Leg', 'denim-theory-womens', 'Jeans', 'women', 'RELAXED', 'LOW', '12 oz denim', 12800, 'Mid Wash', '#5a7393',
    'A high-rise wide-leg jean that sits at the natural waist.'],
  ['kinfolk-heavy-tee', 'Heavyweight Boxy Tee', 'kinfolk-unisex', 'T-shirts', 'unisex', 'OVERSIZED', 'NONE', '240 gsm cotton', 3800, 'Bone', '#e6dfd0',
    'A boxy, heavyweight tee with dropped shoulders. Cut generously — many people size down.'],
  ['kinfolk-easy-trouser', 'Easy Trouser', 'kinfolk-bottoms', 'Trousers', 'unisex', 'RELAXED', 'HIGH', 'Brushed cotton, elastic waist', 7800, 'Charcoal', '#3b3d40',
    'A relaxed pull-on trouser with an elasticated waist and a tapered leg.'],
  ['northline-pique-polo', 'Piqué Polo', 'northline-mens-tops', 'Polos', 'men', 'REGULAR', 'LOW', '100% cotton piqué', 4500, 'Forest Green', '#2f4f3a',
    'A two-button piqué polo with a ribbed collar. Regular fit, slightly longer at the back.'],
  ['northline-pleated-midi', 'Pleated Midi Skirt', 'northline-womens-skirts', 'Skirts', 'women', 'RELAXED', 'NONE', '100% recycled polyester satin', 6900, 'Dusty Rose', '#c48b8f',
    'A fluid knife-pleated midi skirt that sits at the natural waist.'],
  ['atelier-nove-wool-blazer', 'Wool Two-Button Blazer', 'atelier-nove-blazers', 'Blazers', 'men', 'SLIM', 'LOW', '100% virgin wool', 29900, 'Charcoal', '#3a3d42',
    'A half-canvassed two-button blazer with a slim European cut — sized by chest.'],
  ['atelier-nove-womens-blazer', 'Tailored Single-Breasted Blazer', 'atelier-nove-womens-blazers', 'Blazers', 'women', 'REGULAR', 'LOW', 'Wool blend crepe', 25900, 'Ecru', '#e6dcc8',
    'A sharp single-breasted blazer with structured shoulders and a nipped waist.'],
  ['denim-theory-chino-short', 'Chino Short', 'denim-theory-shorts', 'Shorts', 'men', 'REGULAR', 'LOW', 'Cotton twill, 2% elastane', 5900, 'Stone', '#c9bda5',
    'A 7-inch chino short with a flat front and a touch of stretch.'],
  ['denim-theory-trucker', 'Denim Trucker Jacket', 'denim-theory-jackets', 'Jackets', 'unisex', 'REGULAR', 'NONE', '13 oz rigid denim', 11900, 'Light Wash', '#8aa3c2',
    'The classic trucker jacket in rigid denim — room for a hoodie underneath.'],
  ['kinfolk-shirt-dress', 'Linen Shirt Dress', 'kinfolk-dresses', 'Dresses', 'women', 'RELAXED', 'NONE', '100% washed linen', 13900, 'Terracotta', '#b5583a',
    'A relaxed button-through shirt dress with a self-tie belt and midi length.'],
  ['desi-loom-cotton-kurta', 'Handloom Cotton Kurta', 'desi-loom-mens-kurtas', 'Kurtas', 'men', 'REGULAR', 'NONE', '100% handloom cotton', 3900, 'Saffron', '#e08a2c',
    'A knee-length handloom kurta with a mandarin collar and side slits.'],
  ['desi-loom-linen-kurta', 'Linen Short Kurta', 'desi-loom-mens-kurtas', 'Kurtas', 'men', 'SLIM', 'NONE', 'Cotton–linen blend', 4600, 'Ivory', '#f1ead8',
    'A slim, hip-length kurta in breathable cotton–linen — wears well with jeans.'],
  ['desi-loom-nehru-jacket', 'Nehru Jacket', 'desi-loom-nehru-jackets', 'Nehru Jackets', 'men', 'SLIM', 'NONE', 'Silk-blend jacquard', 5900, 'Midnight Blue', '#1f2d4d',
    'A sleeveless bandhgala-collar jacket to layer over a kurta.'],
  ['desi-loom-anarkali', 'Anarkali Kurta', 'desi-loom-womens-kurtas', 'Kurtas', 'women', 'REGULAR', 'LOW', 'Cotton mulmul with block print', 5400, 'Teal', '#1f7a7a',
    'A flared, floor-skimming anarkali, fitted through the bodice and waist.'],
  ['desi-loom-straight-kurta', 'Straight Kurta', 'desi-loom-womens-kurtas', 'Kurtas', 'women', 'REGULAR', 'NONE', '100% cotton', 2900, 'Mustard', '#d4a72c',
    'A straight-cut, calf-length kurta with three-quarter sleeves.'],
  ['stride-training-tee', 'Training Tee', 'stride-tops', 'T-shirts', 'men', 'SLIM', 'HIGH', 'Recycled polyester, 12% elastane', 2900, 'Black', '#1b1c1e',
    'A close-fitting, quick-dry training tee with four-way stretch.'],
  ['stride-zip-hoodie', 'Performance Zip Hoodie', 'stride-tops', 'Hoodies', 'unisex', 'RELAXED', 'MEDIUM', 'Brushed-back polyester fleece', 6900, 'Slate', '#55606e',
    'A relaxed full-zip hoodie in soft brushed fleece with zip pockets.'],
  ['stride-tapered-jogger', 'Tapered Jogger', 'stride-bottoms', 'Joggers', 'unisex', 'REGULAR', 'HIGH', 'Cotton–polyester terry, elastane', 5400, 'Heather Charcoal', '#4a4d52',
    'A tapered jogger with an elastic waist and ribbed cuffs.'],
  ['stride-high-waist-legging', 'High-Waist Legging', 'stride-bottoms', 'Leggings', 'women', 'SLIM', 'HIGH', 'Nylon, 25% elastane', 4900, 'Plum', '#5b2d4f',
    'A squat-proof high-waist legging with a hidden waistband pocket.'],
  ['stride-crop-hoodie', 'Cropped Hoodie', 'stride-tops', 'Hoodies', 'women', 'OVERSIZED', 'MEDIUM', 'Cotton fleece', 5900, 'Sage', '#9cae94',
    'A boxy cropped hoodie with dropped shoulders. Cut generously.'],
  ['kinfolk-relaxed-short', 'Relaxed Pull-On Short', 'kinfolk-bottoms', 'Shorts', 'unisex', 'RELAXED', 'HIGH', 'Brushed cotton, elastic waist', 4200, 'Navy', '#25324a',
    'A pull-on short with an elastic waist — the warm-weather Easy Trouser.'],
];

async function main() {
  const brands = {};
  for (const b of BRANDS) {
    brands[b.slug] = await prisma.brand.upsert({
      where: { slug: b.slug },
      update: { name: b.name, description: b.description, accentHex: b.accentHex },
      create: b,
    });
  }

  const charts = {};
  for (const [name, def] of Object.entries(CHARTS)) {
    const brandId = brands[def.brand].id;
    const chart = await prisma.sizeChart.upsert({
      where: { brandId_name: { brandId, name } },
      update: { category: def.category },
      create: { brandId, name, category: def.category },
    });
    await prisma.sizeChartEntry.deleteMany({ where: { sizeChartId: chart.id } });
    await prisma.sizeChartEntry.createMany({
      data: def.sizes.flatMap(([label, dims], order) =>
        Object.entries(dims).map(([dimension, [minCm, maxCm]]) => ({
          sizeChartId: chart.id,
          sizeLabel: label,
          sortOrder: order,
          dimension,
          minCm,
          maxCm,
        })),
      ),
    });
    charts[name] = chart;
  }

  for (const [slug, name, chart, subcategory, gender, fitIntent, stretch, material, priceCents, colorName, colorHex, description] of GARMENTS) {
    const sc = charts[chart];
    const data = {
      name,
      brandId: sc.brandId,
      sizeChartId: sc.id,
      category: sc.category,
      subcategory,
      gender,
      fitIntent,
      stretch,
      material,
      priceCents,
      colorName,
      colorHex,
      description,
      imageUrl: photoFor(slug),
      isActive: true,
    };
    await prisma.garment.upsert({ where: { slug }, update: data, create: { slug, ...data } });
  }

  const counts = await Promise.all([prisma.brand.count(), prisma.sizeChart.count(), prisma.garment.count()]);
  console.log(`seeded: ${counts[0]} brands, ${counts[1]} size charts, ${counts[2]} garments`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
