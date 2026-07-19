import fs from "node:fs";
import path from "node:path";

const output = path.resolve("data/media/captions/facebook-playful-captions-2000-v3.csv");

const openings = [
  "Caught you looking.", "Careful—you might stay a little longer than planned.",
  "I was going to behave today… almost.", "That smile says innocent; the attitude says otherwise.",
  "Just passing by and casually stealing the spotlight.", "You looked twice—should I be flattered?",
  "A little trouble never looked this cheerful.", "Don’t worry; I only tease the ones paying attention.",
  "Your feed needed a tiny distraction.", "I promise the confidence is completely intentional.",
  "Sweet enough to notice; bold enough to remember.", "If this interrupted your scrolling—good.",
  "Looking innocent is part of the strategy.", "Consider this your favorite little plot twist today.",
  "No mischief here… unless you count the smile.", "I brought the look; you brought the attention.",
  "Be honest—you were not scrolling past this quickly.", "A harmless distraction with excellent timing.",
  "Relax; it is only a little confident energy.", "Someone has to make your timeline more interesting.",
  "I could explain the look—but watching you guess is more fun.", "This is your sign to enjoy the view and smile.",
  "A little charm; a little mystery; plenty of confidence.", "Did the outfit get your attention—or was it the attitude?",
  "Just enough sparkle to make you forget what you were doing."
];

const themes = [
  "The mood is playful confident and impossible to take too seriously.",
  "A bright smile and a bold attitude can cause harmless trouble.",
  "Keeping the look effortless leaves more room for a little mystery.",
  "Some moments deserve confidence with a mischievous twist.",
  "The style stays casual while the personality does all the talking.",
  "It is all fun good energy and just a hint of teasing.",
  "Confidence makes even the simplest moment difficult to ignore.",
  "A playful mood can turn an ordinary scroll into something memorable.",
  "The secret is looking relaxed while knowing exactly what you are doing.",
  "Nothing complicated—just charm confidence and excellent timing."
];

const questions = [
  "So—did I distract you for a second?", "What was the first thing you noticed?",
  "Would you call this sweet or slightly dangerous?", "Can you handle this much playful energy?",
  "Should I keep the innocent look—or reveal the mischief?", "What kind of trouble does this smile suggest?",
  "Did you stop for the style or stay for the attitude?", "One word might not be enough for this mood."
];

const hashtagSets = [
  "#PlayfulMood #ConfidentStyle #GoodVibes",
  "#CaughtYourEye #CasualBeauty #DailyMood",
  "#MischievousSmile #StyleInspiration #JustForFun",
  "#PrettyEnergy #ConfidentWoman #Lifestyle",
  "#SweetAndBold #FashionMood #PositiveVibes",
  "#EffortlessCharm #CasualStyle #DailyInspiration",
  "#MainCharacterMood #BeautifulStyle #GoodEnergy",
  "#PlayfulVibes #ModernBeauty #StyleOfTheDay",
  "#ConfidenceLooksGood #EverydayBeauty #FunMood",
  "#CharmingMood #FashionInspo #SmileMore"
];

const leadStyles = [
  "caught-you-looking", "main-character", "sweet-but-bold", "quietly-mischievous", "spotlight-stealing",
  "double-take", "cheerfully-troublesome", "playfully-teasing", "scroll-stopping", "confidently-casual",
  "sweet-and-memorable", "perfectly-timed", "innocent-looking", "plot-twist", "smile-with-a-secret",
  "attention-winning", "honestly-unskippable", "harmlessly-distracting", "bright-and-confident", "timeline-brightening",
  "keep-them-guessing", "enjoy-the-moment", "charming-and-mysterious", "style-meets-attitude", "sparkle-with-a-wink"
];

const leadMoods = [
  "playful confidence", "effortless charm", "bright energy", "casual elegance", "a knowing smile",
  "lighthearted fun", "natural beauty", "bold personality", "relaxed style", "good-vibes confidence"
];

const leadTwists = [
  "a hint of mystery", "just enough mischief", "perfect timing", "an unexpected spark",
  "a cheeky little twist", "an unforgettable attitude", "a touch of sweetness", "one more reason to look twice"
];

const captions = [];
for (let b = 0; b < themes.length; b += 1) {
  for (let c = 0; c < questions.length; c += 1) {
    for (let a = 0; a < openings.length; a += 1) {
      const tags = hashtagSets[(a * themes.length + b + c) % hashtagSets.length];
      const base = openings[a].replace(/[.!?…]+$/u, "");
      const style = leadStyles[a].replaceAll("-", " ");
      const mood = leadMoods[b];
      const twist = leadTwists[c];
      const leads = [
        `${base}—${mood} with ${twist}.`,
        `${base}; blame the ${mood} and ${twist}.`,
        `${base} because ${mood} works best with ${twist}.`,
        `${base}—a ${style} moment powered by ${mood} and ${twist}.`,
        `${base}; apparently ${mood} plus ${twist} is a dangerous combination.`,
        `${base}—just ${mood} ${twist} and excellent timing.`,
        `${base}; call it ${style} energy with ${mood} and ${twist}.`,
        `${base}—when ${mood} meets ${twist} things get interesting.`
      ];
      captions.push(`${leads[c]} ${questions[c]} ${tags}`);
    }
  }
}

// Deterministic shuffle keeps neighboring rows from sharing the same hook,
// question, mood, or hashtag pattern while producing the same file each run.
let seed = 20260718;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
for (let i = captions.length - 1; i > 0; i -= 1) {
  const j = Math.floor(random() * (i + 1));
  [captions[i], captions[j]] = [captions[j], captions[i]];
}

if (captions.length !== 2000 || new Set(captions).size !== 2000) {
  throw new Error(`Expected 2000 unique captions, got ${captions.length}/${new Set(captions).size}`);
}

const uniqueLeads = new Set(captions.map((caption) => caption.split(". ")[0]));
if (uniqueLeads.size !== 2000) {
  throw new Error(`Expected 2000 unique opening sentences, got ${uniqueLeads.size}`);
}

// Keep each row unquoted for easy viewing/import. Commas are removed so every
// caption remains entirely in the first CSV column.
const csvRow = (value) => String(value).replaceAll(",", "");
const csv = `\uFEFFcaption\r\n${captions.map(csvRow).join("\r\n")}\r\n`;

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, csv, "utf8");
console.log(`${output}\n${captions.length} unique captions`);
