// ── Importing a recipe from a link: the prompt (pure) ───────────────────────
// AjiLab has no AI of its own, so "Import from a link" hands you a prompt to
// paste into a chat assistant, and reads back the recipe it replies with.
//
// The syntax is written down once, here. The editor's Syntax help reads the
// entries marked `help`, and the prompt reads all of them, so the two can't
// drift. test/import-prompt.test.js parses every example and the sample recipe
// with the real parser. When you add syntax, add it here (or to NOT_FOR_IMPORT
// with the reason) and the test keeps you honest.
//
// build() is plain text in, plain text out, so if AjiLab ever calls a model
// itself it can send the same prompt from the server.
const ImportPrompt = (() => {
  // kind: what the parser makes of `example` (checked by the test).
  const SYNTAX = [
    { code: '@ingredient{qty%unit}', example: '@bread flour{500%g}', kind: 'ingredient', help: true,
      rule: 'An ingredient, with its amount and unit, in the step where it is used. Always close it with braces, even for one word.' },
    { code: '@salt{}', example: '@salt{}', kind: 'ingredient',
      rule: 'An ingredient with no amount: to taste, for dusting, for the pan.' },
    { code: '@butter{15%g}(melted)', example: '@butter{15%g}(melted)', kind: 'ingredient',
      rule: 'Preparation goes in parentheses straight after the braces.' },
    { code: '@&water{25%g}', example: '@&water{25%g}', kind: 'ingredient',
      rule: 'The same ingredient used again (more flour or water in a later step): the amounts add up to one line in the ingredient list, and metrics see the total. Something different that shares a name, like water for boiling, gets its own name instead: @boiling water{2%l}.' },
    { code: '@?sesame seeds{1%tbsp}', example: '@?sesame seeds{1%tbsp}', kind: 'ingredient',
      rule: 'An optional ingredient.' },
    { code: '#cookware{}', example: '#dutch oven{}', kind: 'cookware', help: true,
      rule: 'Equipment, the first time a step needs it.' },
    { code: '~{25%min}', example: '~{20-25%min}', kind: 'timer', help: true,
      rule: 'A time: baking, resting, simmering. Ranges are fine: ~{20-25%min}. Units: sec, min, hours.' },
    { code: '^{450%F}', example: '^{230%C}', kind: 'temperature', help: true,
      rule: 'Every temperature (oven, oil, water, dough), in the unit the source uses. Ranges are fine: ^{21-23%C}. Never write a temperature as plain text like 450°F; AjiLab converts these.' },
    { code: '= Section', example: '= Dough', kind: 'section', help: true,
      rule: 'A unit of work (Mix, Bulk, Shape, Bake), on its own line. Leave sections out of a short, one-stage recipe.' },
    { code: '> note', example: '> Wear gloves.', kind: 'note', help: true,
      rule: 'A warning or cue for the step above it, one short sentence. Only when it matters; most recipes need none or one or two.' },
    { code: '@salt{=1%tsp}', example: '@salt{=1%tsp}', kind: 'ingredient', fixed: true, help: true,
      rule: 'An amount that stays the same when the recipe is scaled. Rarely needed.' },
  ];

  const METADATA = [
    { code: 'title: Sourdough Bagels', key: 'title',
      rule: 'The recipe name, short, without the site name or "Best Ever".' },
    { code: 'servings: 4', key: 'servings', help: true,
      rule: 'How many it serves or makes, if the source says.' },
    { code: 'source: URL or book', key: 'source', help: true,
      rule: 'Where it came from: the link, or the book and author.' },
    { code: 'notes: Your notes', key: 'notes', help: true,
      rule: 'Only facts about the whole recipe worth keeping, like yield or storage, one short line each, as a block (notes: |-). Leave it out if there are none.' },
    { code: 'metric.hydration: water.g / flour.g * 100 | %', key: 'metric.hydration', help: true,
      rule: 'A computed figure, shown on the sheet. See Metrics below.' },
  ];

  // AjiLab syntax the prompt deliberately doesn't teach, and why.
  const NOT_FOR_IMPORT = {
    '!+ / !-': 'cook records only: an added or skipped step',
    '@&(=N)': 'something made in an earlier section; written by hand',
    '@-': 'hidden from the ingredient list; written by hand',
    '@./': 'a link to another AjiLab recipe; the assistant can’t know them',
    '%{}': 'an amount with no ingredient, used in metrics; written by hand',
  };

  // How a recipe reads: the writing philosophy. PURPOSE is the reason for
  // every rule, so the assistant can judge cases the rules don't name.
  const PURPOSE = 'The sheet is read mid-cook, at a glance, with busy hands. Every word should be an action, an amount, a time, a temperature or a cue for when it’s done. Anything else costs reading and gives nothing.';

  const PRINCIPLES = [
    'Instructions, not narration. Start with the verb. Don’t describe what the cook can see or has just done (“Once the covered loaf is in the oven, …”).',
    'One action per sentence, and a full stop between actions in sequence: “Cover and rest ~{10%min}. Shape into a boule.” Join with “and” only what is done together. Never write “then”, “next”, “now”, “after that” or “once…”: the order of the sentences is the order of the work.',
    'Drop the words the action already implies: “cover”, not “cover with its lid”; “reduce temperature”, not “reduce the oven temperature”; “on a floured surface”, not “scrape onto a surface dusted with flour”. Leave out filler (“carefully”, “go ahead and”, “you’ll want to”).',
    'Say what to do and how you know it’s done, not how a cook does it: “Tighten the surface.”, “until no dry flour remains”. Leave out technique a home cook knows (“with a bench scraper, drawing the loaf toward you”).',
    'One way to do it: the author’s main method. Leave out the alternatives (“or slide onto a baking stone and cover with a bowl”, “a boule or batard”).',
    'Say a thing once. Don’t restate what an earlier step did (the pot is hot because it was preheated), and call each thing by one short name throughout (“the dough”, not the dough, the mass and the mixture).',
    'Words only for what numbers can’t carry: doneness cues (“until doubled”) and warnings that would ruin the dish if missed (“without deflating”). Explain why only when the reason changes what the cook does. Most recipes need no notes.',
    'A step is what you do in one go. It usually ends at a wait (its timer is the last thing in it), a move to a new place or heat, or a point the cook would check off. Fold small actions into the step they belong to; split a step that has two waits.',
    'Sections are stages of work done in one stretch (Mix, Bulk, Shape, Bake), not headings for readability. A short, one-stage recipe has none.',
  ];

  // Edits of an assistant's steps into the house style (checked by the test:
  // both parse, the edit is under half the length, and it never says
  // "then"). The first two are the owner's own edits.
  const BEFORE_AFTER = [
    {
      before: 'Transfer into the hot Dutch oven and cover with its lid, or slide onto the baking stone and cover with a #stainless steel bowl{} or #hotel pan{}. Once the covered loaf is in the oven, reduce the oven temperature to ^{450%F} and bake ~{30%min}.',
      after: 'Transfer into #Dutch oven{}, cover and reduce temperature to ^{450%F}. Bake ~{30%min}.',
    },
    {
      before: 'Scrape onto a surface dusted with @flour{}, fold into a boule or batard without deflating, and turn seam side down. Tighten the surface with a #bench scraper{} by drawing the loaf toward you and away, then cover and rest ~{10%min}.',
      after: 'On a floured surface fold into a boule without deflating. Tighten the surface. Cover and rest ~{10%min}.',
    },
    {
      before: 'In a large #bowl{}, combine the @bread flour{450%g} and @water{350%g}. Using your hand, mix until no dry flour remains.\n\nCover the bowl with a towel and let it rest for ~{1%hour}. This rest, called the autolyse, gives the flour time to absorb the water and makes the dough easier to work.\n\nAfter the rest, add the @salt{10%g} to the bowl and squeeze it in until it is evenly distributed.',
      after: 'Mix @bread flour{450%g} and @water{350%g} in a #bowl{} until no dry flour remains. Cover and rest ~{1%hour}.\n\nAdd @salt{10%g} and squeeze in until even.',
    },
  ];

  const HOUSE_STYLE = [
    'Write each ingredient inline, in the step where it is used. Don’t write a separate ingredient list; AjiLab builds it from the steps.',
    'If an ingredient is used in two steps, give each use its own amount where it is used, and write the later ones with @& so they add up.',
    'Keep the author’s amounts and units exactly. Don’t convert, round, scale or improve anything. When the source gives both weights and cups, use the weights.',
    'Use short unit names: g, kg, ml, l, tsp, tbsp, cup, oz, lb. Write fractions as 1/2 and ranges as 12-14. Put a blank line between steps.',
    'Leave out the story, ads, nutrition, ratings, comments and serving suggestions. Of the author’s tips, keep only the ones that would change the result if missed.',
    'If something on the page is unclear or missing, don’t guess: say so in a > note.',
  ];

  // When a recipe gets metrics, and how to write them. Not only bread: any
  // recipe where a ratio is what you'd check or adjust.
  const METRICS = {
    when: [
      'Add a few computed figures when a ratio defines the recipe and a cook would check or adjust it between tries. Usually one to three; most everyday recipes need none.',
      'Breads and doughs: hydration (all the water over all the flour), salt, and a starter or preferment, each as a % of the flour.',
      'Ferments, cures and brines: salt (and sugar, if any) as a % of the vegetables, the meat or the water. Cultured butter: salt as a % of the butter.',
      'Others when they matter: sugar or fat in an ice cream base, oil to acid in a dressing, water to rice.',
      'If the author states a figure ("75% hydration", "a 2% brine"), include it, and make sure your formula gives the same number.',
    ],
    how: [
      'In the metadata: `metric.<name>: <formula> | <unit>`. `| %` shows a percentage; a plain ratio needs no unit.',
      'Refer to an ingredient by its name in the steps, with spaces as underscores, plus the unit it is written in: `whole_wheat_flour.g` if weighed, `milk.ml` if measured by volume (formulas don’t convert between the two). Use + - * / and parentheses.',
      'A helper figure the sheet shouldn’t show ends in `| hidden`. A later figure can use it as `metric.<name>`; define it first.',
      'Count what is inside a mixed ingredient: a starter at 100% hydration is half flour, half water (use the author’s figure if they give one).',
      'Metrics only work with weights or metric volumes (g, kg, ml, l). If the recipe is in cups or spoons, leave them out.',
      'If an amount is a range because the author lets you choose (“365-380 g water”), keep the range; the figure shows as a range too (73-76%).',
    ],
  };

  // Limits the sample recipe keeps to (checked by the test), so it shows the
  // brevity it asks for.
  const EXAMPLE_LIMITS = { wordsPerStep: 30, notes: 1 };

  // A small recipe in the house style. The test parses it.
  const EXAMPLE = `---
title: Brown Butter Cornbread
servings: 8
source: https://example.com/brown-butter-cornbread
notes: |-
  Keeps 2 days wrapped at room temperature.
  Reheat slices in a dry pan.
---

= Batter

Preheat the #oven{} to ^{425%F} with a #cast-iron skillet{} inside.

Brown @butter{113%g}(cubed) in a #saucepan{} until nutty, ~{5-6%min}.

> It burns fast after it foams.

Whisk @cornmeal{150%g}, @all-purpose flour{125%g}, @sugar{50%g}, @baking powder{2%tsp} and @salt{1%tsp} in a #bowl{}.

Whisk in @buttermilk{360%ml}, @eggs{2} and most of the butter until just combined.

= Bake

Swirl the rest of the butter in the skillet and pour in the batter. Bake ~{20-25%min} until golden.

Sprinkle with @flaky salt{} and cool ~{10%min} in the skillet.
`;

  // A dough with metrics, the way they're written. The test checks the figures.
  const METRIC_EXAMPLE = `---
title: Country Loaf
source: https://example.com/country-loaf
metric.total_flour: bread_flour.g + whole_wheat_flour.g + levain.g * 0.5 | g | hidden
metric.total_water: water.g + levain.g * 0.5 | g | hidden
metric.hydration: metric.total_water / metric.total_flour * 100 | %
metric.salt: salt.g / metric.total_flour * 100 | %
metric.levain: levain.g / metric.total_flour * 100 | %
---

= Mix

Mix @bread flour{450%g}, @whole wheat flour{50%g} and @water{350%g} in a #bowl{}. Rest ~{1%hour}.

Add @levain{100%g}(100% hydration), @salt{10%g} and @&water{25%g}, and squeeze in until even.

= Bulk

Ferment at ^{24-26%C} for ~{4-5%hours}, folding 4 times in the first 2 hours, until risen by half.

= Shape and Bake

Shape into a boule. Refrigerate in a floured #banneton{} ~{12-16%hours}.

Preheat a #dutch oven{} at ^{500%F} for ~{45%min}.

Score and bake covered ~{20%min}.

Uncover, reduce to ^{450%F} and bake ~{20-25%min} until deep brown.
`;

  function build({ url = '' } = {}) {
    const link = String(url || '').trim();
    const syntax = SYNTAX.map((item) => `- \`${item.code}\` — ${item.rule}`).join('\n');
    const metadata = METADATA.map((item) => `- \`${item.code}\` — ${item.rule}`).join('\n');
    const style = HOUSE_STYLE.map((rule) => `- ${rule}`).join('\n');
    const principles = PRINCIPLES.map((rule, i) => `${i + 1}. ${rule}`).join('\n');
    const edits = BEFORE_AFTER.map((pair) => `Not:\n${pair.before}\n\nBut:\n${pair.after}`).join('\n\n');
    const list = (rules) => rules.map((rule) => `- ${rule}`).join('\n');
    const what = link
      ? `Turn the recipe at this link into Cooklang for AjiLab, my recipe app:\n${link}`
      : 'Turn the recipe I give you (pasted after this message, or in a photo) into Cooklang for AjiLab, my recipe app.';
    const reply = [
      'Reply with only the recipe, in one ```cooklang code block. No introduction, no summary after it.',
      // An assistant that can't browse will otherwise invent one.
      link ? "If you can't open the link, say so and stop. Don't write the recipe from memory or make one up." : '',
    ].filter(Boolean).join('\n');
    return `${what}

${reply}

## The format

The recipe starts with metadata between --- lines, then the steps.

Metadata:
${metadata}

In the steps:
${syntax}

## How to write it

${PURPOSE}

${principles}

Edits that show it:

${edits}

## House style

${style}

## Metrics

${list(METRICS.when)}

How to write them:
${list(METRICS.how)}

## Example

\`\`\`cooklang
${EXAMPLE}\`\`\`

## Example with metrics

\`\`\`cooklang
${METRIC_EXAMPLE}\`\`\`
`;
  }

  // The assistant's reply → the recipe text: the first code block if there is
  // one (assistants add chatter around it), else the whole reply.
  function fromReply(reply) {
    const text = String(reply || '').replace(/\r\n/g, '\n');
    const fenced = text.match(/```[^\n]*\n([\s\S]*?)\n?```/);
    const body = (fenced ? fenced[1] : text).trim();
    return body ? `${body}\n` : '';
  }

  // What the parsed reply holds, for the check before creating it.
  function summarize(parsed) {
    const steps = parsed?.steps || [];
    const plain = (step) => (step.every((token) => token.type === 'text') ? step.map((token) => token.value).join('') : null);
    const sections = steps.filter((step) => /^\s*=\s+/.test(plain(step) ?? '')).length;
    const notes = steps.filter((step) => (step.length === 1 && step[0]?.type === 'comment') || /^\s*>\s/.test(plain(step) ?? '')).length;
    return {
      title: parsed?.metadata?.title || '',
      ingredients: new Set((parsed?.ingredients || []).map((item) => String(item.name || '').toLowerCase())).size,
      steps: steps.length - sections - notes,
      sections,
      error: parsed?.error || '',
    };
  }

  return { SYNTAX, METADATA, NOT_FOR_IMPORT, PURPOSE, PRINCIPLES, BEFORE_AFTER, HOUSE_STYLE, METRICS, EXAMPLE, METRIC_EXAMPLE, EXAMPLE_LIMITS, build, fromReply, summarize };
})();
