import fs from "node:fs";
import path from "node:path";

const output = path.resolve("data/media/captions/american-beauty-first-person-3000-v5.csv");

const portraits = [
  "She has the kind of smile that makes the whole timeline feel warmer",
  "American beauty looks effortless when confidence leads the way",
  "She carries sunshine in her expression and freedom in her spirit",
  "Somewhere between sweet and fearless she found her perfect glow",
  "She turns an ordinary moment into something worth remembering",
  "That all-American charm arrives with a playful little spark",
  "Her confidence speaks softly and still gets everyone’s attention",
  "She is equal parts grace good humor and unforgettable energy",
  "A bright smile and a bold heart will always stand out",
  "She makes casual beauty look like its own kind of art",
  "There is a little bit of summer hidden in her smile",
  "She wears confidence like it was made especially for her",
  "Beauty becomes magnetic when personality shines through",
  "She brings a fresh American spirit to every little moment",
  "That smile could brighten a road trip from coast to coast",
  "She looks like good news on an otherwise ordinary day",
  "A beautiful woman with a free spirit is difficult to forget",
  "She has city confidence and an open-sky kind of soul",
  "Her charm feels natural bright and wonderfully unbothered",
  "She leaves a little sparkle wherever the day takes her",
  "The look is lovely but the attitude makes it memorable",
  "She carries the easy confidence of a perfect American afternoon",
  "One glance and suddenly the day has a better soundtrack",
  "Her smile belongs somewhere between a love song and a summer sky",
  "She is the unexpected highlight your feed did not know it needed",
  "A touch of mischief makes that beautiful smile even brighter",
  "She has the rare kind of beauty that feels alive and genuine",
  "The camera found the glow but confidence created it",
  "She brings a little poetry to the everyday American scene",
  "Her energy feels like windows down and a favorite song playing",
  "She is proof that elegance can still have a playful side",
  "That confident look could stop traffic without making a sound",
  "She makes simplicity feel vivid fresh and completely unforgettable",
  "A beautiful face catches the eye but her spirit holds the moment",
  "She has the glow of golden hour and the confidence of downtown lights",
  "Her style whispers while her presence makes the statement",
  "She brings soft beauty and fearless energy into perfect balance",
  "That smile feels like the first warm day after a long winter",
  "She looks ready for new roads bright skies and good stories",
  "A naturally beautiful moment with a distinctly American heartbeat",
  "Her confidence is calm but the effect is impossible to miss",
  "She makes the world look a little more cinematic for a moment",
  "That playful expression has a whole story hiding behind it",
  "She brings the charm of small towns and the confidence of big cities",
  "Beauty this relaxed never needs to ask for attention",
  "She looks like freedom laughter and a little harmless trouble",
  "Her glow has the warmth of a late summer evening",
  "She turns confidence into something graceful and completely natural",
  "A bright American mood wrapped in beauty and personality",
  "She has the kind of presence that makes scrolling feel impossible"
];

const atmospheres = [
  "with golden-hour warmth and an easygoing mood",
  "under wide-open skies and a feeling of pure freedom",
  "with city-light confidence and a touch of mystery",
  "in a moment filled with sunshine laughter and good energy",
  "with coast-to-coast charm and a modern feminine spirit",
  "like a scene from a summer story you wish lasted longer",
  "with the relaxed rhythm of an unforgettable weekend",
  "where natural beauty meets a bold independent heart",
  "with classic charm and a fresh playful attitude",
  "like a favorite song drifting through an open car window",
  "with a soft glow and the confidence to own the moment",
  "where everyday style becomes something quietly captivating"
];

const flourishes = [
  "What a beautiful way to brighten the day!",
  "Some moments simply deserve an extra second of attention.",
  "A little charm like this goes a very long way!",
  "The view is lovely and the energy is even better.",
  "Now that is how confidence should look!"
];

const poeticLines = [
  "Sunlight in her smile and a whole horizon in her eyes.",
  "She arrives like summer—bright warm and impossible to ignore!",
  "A lovely face may catch the light but her spirit creates the glow.",
  "From city streets to open skies her confidence belongs everywhere.",
  "The day wrote a small poem and placed her smile at the center.",
  "Some beauty is seen; the best kind is also felt.",
  "She carries a little starlight even in the middle of the day!",
  "Freedom looks beautiful when it is worn with a genuine smile.",
  "A soft breeze a bright sky and one unforgettable presence.",
  "She is a bright chapter in the great American summer story."
];

const rareQuestions = [
  "Was it the smile or the confidence that caught your attention first?",
  "Could any timeline use a little more sunshine like this?",
  "Is this sweet charm or playful trouble in disguise?",
  "Which American city matches this confident energy?",
  "Does this mood feel more like city lights or a California sunset?"
];

const hashtags = [
  "#AmericanBeauty #ConfidentWoman #BeautifulMoments",
  "#AllAmericanStyle #NaturalBeauty #GoodEnergy",
  "#AmericanGirls #PlayfulCharm #DailyInspiration",
  "#BeautifulWomen #ConfidentStyle #PositiveVibes",
  "#AmericanStyle #GoldenHourGlow #Lifestyle",
  "#ModernBeauty #FreeSpirit #StyleInspiration",
  "#EverydayBeauty #AmericanSpirit #GoodVibes",
  "#CharmingSmile #ConfidentBeauty #DailyMood",
  "#BeautyAndConfidence #AmericanLifestyle #FreshEnergy",
  "#TimelessBeauty #PlayfulMood #FashionInspo",
  "#NaturalCharm #BeautifulStyle #BrightMood",
  "#AmericanVibes #ElegantBeauty #FeelGood",
  "#HerStyle #AmericanDreaming #ConfidentLiving",
  "#LovelyMoments #ModernWoman #PositiveEnergy",
  "#BeautyInspiration #FreeSpirited #SmileMore"
];

function firstPerson(text) {
  let value = String(text)
    .replace(/\bShe has\b/g, "I have")
    .replace(/\bShe carries\b/g, "I carry")
    .replace(/\bShe turns\b/g, "I turn")
    .replace(/\bShe makes\b/g, "I make")
    .replace(/\bShe wears\b/g, "I wear")
    .replace(/\bShe brings\b/g, "I bring")
    .replace(/\bShe looks\b/g, "I look")
    .replace(/\bShe leaves\b/g, "I leave")
    .replace(/\bShe arrives\b/g, "I arrive")
    .replace(/\bShe is\b/g, "I am")
    .replace(/\bshe found\b/g, "I found")
    .replace(/\bshe wishes\b/g, "I wish")
    .replace(/\bHer\b/g, "My")
    .replace(/\bher\b/g, "my")
    .replace(/\bShe\b/g, "I")
    .replace(/\bshe\b/g, "I");

  if (!/\b(?:I|my|me)\b/i.test(value)) {
    value = `${value.replace(/[.!]+$/u, "")}—and it feels completely like me`;
  }
  return value;
}

const captions = [];
let index = 0;
for (let p = 0; p < portraits.length; p += 1) {
  for (let a = 0; a < atmospheres.length; a += 1) {
    for (let f = 0; f < flourishes.length; f += 1) {
      const portrait = firstPerson(portraits[p]);
      const atmosphere = atmospheres[a];
      const flourish = flourishes[f];
      const poem = firstPerson(poeticLines[(p + a + f) % poeticLines.length]);
      const tag = hashtags[(p * 3 + a + f) % hashtags.length];
      const style = index % 12;
      let caption;

      if (style === 0) caption = `${portrait} ${atmosphere}. ${flourish} ${tag}`;
      else if (style === 1) caption = `${poem} ${portrait} ${atmosphere}. ${tag}`;
      else if (style === 2) caption = `${flourish} ${portrait} ${atmosphere}. ${tag}`;
      else if (style === 3) caption = `${portrait} ${atmosphere}! ${poem} ${flourish} ${tag}`;
      else if (style === 4) caption = `${portrait} ${atmosphere}—a scene with its own quiet magic. ${tag}`;
      else if (style === 5) caption = `${poem} ${flourish} ${portrait} ${atmosphere}. ${tag}`;
      else if (style === 6) caption = `${portrait}; ${atmosphere.replace(/^with |^where |^like |^in /, "")}! ${flourish} ${tag}`;
      else if (style === 7) caption = `${portrait} ${atmosphere}. A bright little pause in the middle of the scroll! ${tag}`;
      else if (style === 8) caption = `${flourish} ${poem} ${portrait} ${atmosphere}. ${tag}`;
      else if (style === 9) caption = `${portrait}—${atmosphere}. Beauty confidence and a touch of American sunshine! ${tag}`;
      else if (style === 10) caption = `${poem} ${portrait} ${atmosphere}; the kind of moment that stays with you. ${tag}`;
      else caption = `${portrait} ${atmosphere}. ${index % 20 === 11 ? rareQuestions[(p + a + f) % rareQuestions.length] : flourish} ${tag}`;

      captions.push(caption.replaceAll(",", ""));
      index += 1;
    }
  }
}

if (captions.length !== 3000 || new Set(captions).size !== 3000) {
  throw new Error(`Expected 3000 unique captions got ${captions.length}/${new Set(captions).size}`);
}

let seed = 2026071804;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
for (let i = captions.length - 1; i > 0; i -= 1) {
  const j = Math.floor(random() * (i + 1));
  [captions[i], captions[j]] = [captions[j], captions[i]];
}

const questionCount = captions.filter((caption) => caption.includes("?")).length;
if (questionCount > 180) throw new Error(`Too many questions: ${questionCount}`);

const csv = `\uFEFFcaption\r\n${captions.join("\r\n")}\r\n`;
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, csv, "utf8");
console.log(`${output}\n${captions.length} unique captions\n${questionCount} questions`);
