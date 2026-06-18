import { getOpenAI, getGroq, MODELS, GROQ_MODELS } from '../ai/client';

export interface ScriptInput {
  brand: string;
  allegation: string;
  theme: string;
  source: string;
  severity: number;
}

export interface ScriptOutput {
  script: string;
  title: string;
  keyPoints: string[];
  duration: string;
  usedAI: boolean;
}

// Template library — one per detected theme
const TEMPLATES: Record<string, (b: string, a: string) => string> = {
  'Data Security': (b, a) => `Hi, I'm speaking on behalf of ${b}.

We're aware of concerns circulating online about data security. I want to address this directly and transparently.

${b} takes user privacy and security as our most fundamental obligation. We maintain AES-256 encryption at rest, regular third-party security audits, and strict zero-trust access controls across all systems.

Regarding the specific concern — our security team has conducted an immediate review and found no evidence of any unauthorized access or data exposure affecting our users.

That said, we are taking this seriously. We have commissioned an independent forensic security audit, and we will share the full results publicly within 72 hours.

If you have been personally affected or have additional information, please contact security@${b.toLowerCase().replace(/[^a-z]/g, '')}.com directly. Every report receives a personal response within 24 hours.

Trust, once questioned, must be earned back through action — not words. We commit to full transparency throughout this process.`,

  'Legal Action': (b, a) => `This is ${b}, and I want to address the legal matter directly.

We are aware of the proceedings referenced online. Our legal team has been fully engaged and we are cooperating with all relevant authorities and processes.

${b} operates with integrity and in full compliance with all applicable laws and regulations. We are confident in our position and will address this through the appropriate legal channels.

We are unable to comment further on the specific details while the matter is active, as doing so could prejudice the process. However, we want our community to know that we are committed to a transparent resolution.

We have retained independent counsel, and a detailed factual statement will be published on our official website within 48 hours.

We appreciate your patience and continued trust. We will share updates as soon as we legally are able to do so.`,

  'Fraud/Deception': (b, a) => `My name is with ${b}, and I need to address allegations that have been spreading online directly.

Let me be clear: the claims of fraud or deception are categorically false. ${b} has operated with complete transparency since our founding, and we have the documentation to prove every claim we have ever made.

Here are the facts. We are a legitimately registered business, fully compliant with all applicable consumer protection laws. Every product claim we make is backed by independently verifiable data. Our terms of service are public, clear, and fair.

We take misinformation seriously because it harms consumers who may be making decisions based on false claims. We have already shared all relevant documentation with the appropriate regulatory bodies, who have confirmed our compliance.

We invite anyone with genuine concerns to review our public records, speak with our verified customers, or reach out to us directly. Our full audit history and compliance certificates are available at our website.

The truth is our strongest defense, and we stand firmly behind it.`,

  'Pricing': (b, a) => `This is ${b}, and I want to speak openly about the pricing concerns we have been hearing from our community.

We hear you, and your feedback matters enormously to us. Pricing is one of the most important conversations we can have, and we want to have it honestly.

Here is the full picture. Every dollar of our pricing directly funds the infrastructure, security, and development that keeps your data safe and our service reliable. Our average user achieves a measurable return that exceeds their subscription cost within the first month — and we have the data to show this.

That said, we acknowledge that not every user's situation is the same. Effective immediately, we are introducing a flexible lower tier and extending our free trial from 14 to 30 days. We are also establishing a hardship program for users who need it.

Pricing should always reflect genuine value. If it doesn't for you personally, we want to know — please reach out to our team directly and we will work with you to find a solution.

We are committed to being the most fairly priced option in our category.`,

  'Product Quality': (b, a) => `This is ${b}, and I want to address the product quality concerns our users have raised — directly and without excuses.

First, to everyone who has experienced issues: I'm sorry. You deserve a reliable product and you have not been getting that. That is on us.

Here is what happened and what we are doing about it. We identified a defect introduced in our most recent release that affected a specific subset of users. Our engineering team tripled overnight shifts and has already resolved the issue for 85 percent of affected users. The remaining cases are targeted for resolution within 48 hours.

Every affected user will receive direct communication, a full credit to their account for the affected period, and priority access to our support team.

We have also implemented new pre-release testing protocols and a dedicated quality assurance team to prevent similar issues from reaching production.

We know trust must be rebuilt through consistent action. We commit to a public postmortem with full technical details and a timeline of our quality improvements — published within one week.`,

  'Customer Support': (b, a) => `This is ${b}, and I am personally addressing the complaints about our customer support response times.

You are right to be frustrated. Our support response times have fallen well below our own standards, and more importantly, below yours. I want to be honest about why this happened and exactly what we are doing to fix it.

We underestimated the surge in support volume following our latest release. Rather than scaling our team ahead of the launch, we fell behind. That was a planning failure, and it has caused real harm to our users. I apologize.

Here is what is happening right now. We have hired fifteen additional support specialists who will be fully operational within two weeks. We have also implemented an AI-assisted triage system that routes urgent issues to senior agents within two hours.

Every unanswered ticket from the past 30 days has been personally reviewed and is being addressed this week. You will hear from us.

If you are still waiting, please email priority@${b.toLowerCase().replace(/[^a-z]/g, '')}.com with the subject "Priority Support" and you will receive a response within four hours — guaranteed.`,

  'Workplace Issues': (b, a) => `This is ${b}, and I want to address the workplace concerns that have been raised publicly.

We take every allegation about our workplace culture seriously. A healthy, safe, and respectful work environment is not just an HR priority — it is a moral obligation and a business necessity. When we fall short of that, we need to be accountable.

We have engaged an independent third-party firm to conduct a comprehensive review of our internal culture, reporting structures, and HR processes. Their findings will inform concrete policy changes, and we will publish their recommendations and our action plan publicly.

Any employee who has experienced or witnessed behavior that violates our values is encouraged to use our anonymous reporting channel, which is managed by an independent external provider and protected from any form of retaliation.

We recognize that words are not enough. Our employees deserve action, and our commitment is to create a workplace that every member of our team is proud to be part of. We will share progress updates monthly.`,

  'General Reputation': (b, _a) => `This is ${b}, and I want to speak directly to our community about concerns we have seen raised online.

We take every piece of feedback seriously — both the praise and the criticism. It is how we identify where we are falling short of your expectations and our own.

We have conducted an internal review of the concerns raised. Some of this feedback has surfaced real areas where we can do better, and we are actively making those improvements. Other claims do not accurately reflect our practices or policies, and we are publishing a detailed factual response on our website today.

Here is what has not changed: our core commitment to building something you can trust, rely on, and recommend to the people you care about. That commitment is why we have been listening to this feedback and why we will act on it.

We have a customer advisory board, a public product changelog, and monthly town halls where we address concerns directly. We invite you to engage with us there.

Thank you for holding us to a high standard. We are committed to meeting it.`,
};

const SCRIPT_PROMPT = (brand: string, theme: string, severity: number, allegation: string) =>
  `You are a crisis communications expert. Write a 60-90 second video response script for "${brand}".

Crisis details:
- Theme: ${theme}
- Severity: ${severity}/10
- Context: "${allegation.slice(0, 250)}"

Requirements:
- Natural spoken language, 150-200 words
- Acknowledge → Address specific concern → Present facts → State concrete action → Invite engagement
- Empathetic but factual tone, no admission of unproven wrongdoing
- End with a specific, actionable commitment
- NO stage directions, NO [brackets], NO formatting — just the script text itself`;

export async function generateScript(input: ScriptInput): Promise<ScriptOutput> {
  const { brand, allegation, theme, severity } = input;
  const prompt = SCRIPT_PROMPT(brand, theme, severity, allegation);

  // Try OpenAI first, then Groq as fallback.
  const ai = getOpenAI() ?? getGroq();
  const model = getOpenAI() ? MODELS.fast : GROQ_MODELS.fast;

  if (ai) {
    try {
      const res = await ai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 450,
        temperature: 0.65,
      });
      const script = res.choices[0]?.message?.content?.trim() ?? '';
      if (script.length > 80) {
        return buildOutput(script, brand, theme, true);
      }
    } catch {
      // fall through to template
    }
  }

  const fn = TEMPLATES[theme] ?? TEMPLATES['General Reputation'];
  return buildOutput(fn(brand, allegation), brand, theme, false);
}

function buildOutput(script: string, brand: string, theme: string, usedAI: boolean): ScriptOutput {
  const words = script.split(/\s+/).length;
  const secs = Math.ceil(words / 2.4); // ~144 wpm speaking pace
  const m = Math.floor(secs / 60);
  const s = secs % 60;

  return {
    script,
    title: `${brand} — Official Response: ${theme}`,
    keyPoints: extractKeyPoints(script),
    duration: m > 0 ? `${m}m ${s}s` : `${s}s`,
    usedAI,
  };
}

function extractKeyPoints(script: string): string[] {
  const sentences = script
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 25);
  const actionRx = /we (are|have|will|commit|promis|immediately|launch|publish|implement|deploy)|action|fix|resolv|address|contact|within|hours|days|week/i;
  const hits = sentences.filter(s => actionRx.test(s)).slice(0, 3);
  return hits.length >= 2 ? hits : sentences.slice(0, 3);
}
