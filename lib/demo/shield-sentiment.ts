/** Unambiguous crisis words — one is enough to raise a crisis. */
const CRISIS = new Set([
  'fraud','scam','lawsuit','sue','sued','suing','breach','hack',
  'hacked','stolen','corrupt','corruption','criminal','illegal',
  'bankrupt','bankruptcy','collapse','shutdown','recall','dangerous','unsafe',
  'explosion','discrimination','racist','racism','sexist','abuse',
  'abused','exploit','exploitation','whistleblower','ponzi','embezzl','extort',
  'manipulate','manipulation','bribe','bribery','coverup','cover-up','negligence',
  'negligent','defamation','libel','slander','mislead','defraud',
]);

/**
 * Crisis-adjacent but routine in ordinary news ("joint investigation team",
 * "three arrested", "the minister resigned"). One of these alone is not a
 * brand crisis; two distinct ones together is. Alone they count as negative.
 */
const CRISIS_WEAK = new Set([
  'investigation','investigating','investigated','arrest','arrested','arrests',
  'death','deaths','resign','resigns','resigned',
]);

// Removed from NEGATIVE — these fire on routine business news and carry no
// sentiment on their own: issue(s) ("issues Q3 guidance"), problem(s), concern(s),
// critical, alleged/allegedly, down ("down the road"), expensive, refund
// ("refund policy"), negative, bad. Each false positive cost an OpenAI
// script generation and a slot in the customer's attention queue.
const NEGATIVE = new Set([
  'terrible','awful','horrible','dreadful','disgusting','pathetic','useless',
  'worthless','garbage','trash','worst','worse','broken','bug','bugs',
  'buggy','crash','crashes','crashing','slow','unreliable','unstable',
  'outage','offline','fail','failed','failing','failure','disaster','disappointed',
  'disappointing','frustrating','frustrated','frustration','angry','furious','rage',
  'upset','hate','hated','avoid','boycott','chargeback','overpriced',
  'ripoff','waste','misleading','deceptive','lied','lying','dishonest',
  'unethical','incompetent','unprofessional','rude','arrogant','spam','spammy',
  'sketchy','shady','suspicious','warning','beware','complaint','complaints',
  'controversy','controversial','scandal','embarrassing','accusation',
  'criticism','wrong','error','errors','unusable','disappoints',
]);

const POSITIVE = new Set([
  'amazing','awesome','excellent','fantastic','wonderful','great','good','best',
  'love','loved','perfect','brilliant','outstanding','exceptional','superb',
  'incredible','impressive','helpful','useful','recommend','reliable','trustworthy',
  'professional','efficient','fast','innovative','happy','pleased','satisfied',
  'thankful','grateful','appreciate','success','successful','winning','leader',
]);

export interface SentimentResult {
  score: number;
  severity: number;
  label: 'crisis' | 'negative' | 'neutral' | 'positive';
  crisisWords: string[];
  negWords: string[];
  theme: string;
}

export function scoreMention(title: string, body: string): SentimentResult {
  const text = `${title} ${body}`.toLowerCase();
  const words = text.split(/\W+/).filter(Boolean);

  const foundCrisis: string[] = [];
  const foundWeak: string[] = [];
  const foundNeg: string[] = [];
  let pos = 0;

  for (const w of words) {
    if (CRISIS.has(w)) foundCrisis.push(w);
    else if (CRISIS_WEAK.has(w)) foundWeak.push(w);
    else if (NEGATIVE.has(w)) foundNeg.push(w);
    else if (POSITIVE.has(w)) pos++;
  }

  // Weak crisis words escalate only alongside another crisis signal — two
  // *distinct* ones, or a real one. Repetition doesn't count: an article that
  // says "investigation" four times is still one signal.
  if (foundCrisis.length > 0 || new Set(foundWeak).size >= 2) foundCrisis.push(...foundWeak);
  else foundNeg.push(...foundWeak);

  const rawScore = pos - foundNeg.length - foundCrisis.length * 3;
  const score = Math.max(-10, Math.min(10, rawScore));

  let label: SentimentResult['label'];
  let severity: number;

  if (foundCrisis.length > 0) {
    label = 'crisis';
    severity = Math.min(10, 7 + foundCrisis.length);
  } else if (score < -1 || foundNeg.length >= 2) {
    label = 'negative';
    severity = Math.min(7, 2 + foundNeg.length);
  } else if (score > 0 && foundNeg.length === 0) {
    // One positive word and nothing negative is enough — `score > 1` meant a
    // single "love"/"great" landed as neutral. Any negative word still holds it
    // at neutral, so genuinely mixed news doesn't read as praise.
    label = 'positive';
    severity = 0;
  } else {
    label = 'neutral';
    severity = 1;
  }

  return {
    score,
    severity,
    label,
    crisisWords: [...new Set(foundCrisis)].slice(0, 4),
    negWords: [...new Set(foundNeg)].slice(0, 4),
    theme: detectTheme(text),
  };
}

function detectTheme(text: string): string {
  if (/breach|hack|data|privacy|security|leak|password|cyber/i.test(text)) return 'Data Security';
  if (/lawsuit|sue|court|legal|lawyer|attorney|settlement|litigation/i.test(text)) return 'Legal Action';
  if (/fraud|scam|fake|mislead|deceiv|dishonest|ponzi|embezzl/i.test(text)) return 'Fraud/Deception';
  if (/price|expensive|cost|fee|billing|charge|overpriced|subscription/i.test(text)) return 'Pricing';
  if (/crash|bug|broken|error|outage|down|slow|unreliable|glitch/i.test(text)) return 'Product Quality';
  if (/support|customer service|response|reply|ignored|wait|ticket/i.test(text)) return 'Customer Support';
  if (/fire|layoff|employee|worker|staff|toxic|culture|workplace/i.test(text)) return 'Workplace Issues';
  if (/racist|discriminat|bias|unfair|unjust|abuse|harass/i.test(text)) return 'Discrimination';
  if (/competitor|alternative|better|switch|cancel|leave|comparison/i.test(text)) return 'Competitor Comparison';
  if (/environment|climate|pollution|sustainab|carbon|waste/i.test(text)) return 'Environmental';
  return 'General Reputation';
}
