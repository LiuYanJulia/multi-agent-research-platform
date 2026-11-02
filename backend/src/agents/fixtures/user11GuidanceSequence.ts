import { GuidanceSpec, GuidanceContextMove, Orientation, TmLevel } from '../manipulationController';

export interface User11GuidanceCase {
  auditCaseId: number;
  spec: GuidanceSpec;
  currentWriting: string;
}

function spec(auditCaseId: number, targetOrientation: Orientation, magnitude: TmLevel, descriptions: string[]): GuidanceSpec {
  const selectedContextMoves: GuidanceContextMove[] = descriptions.map((description, index) => ({
    moveId: index + 1,
    moveType: targetOrientation === 'D' ? 1 : 4,
    orientation: targetOrientation,
    description,
  }));
  return {
    policyVersion: 'tm-context-v2', targetOrientation, triggerOrientation: targetOrientation, magnitude,
    phase: targetOrientation === 'D' ? 'collect' : 'synthesize', contextLimit: selectedContextMoves.length,
    availableContextCount: selectedContextMoves.length, selectedContextMoves, recentWritingContext: [],
    requiredIdeaCount: targetOrientation === 'D' ? 6 : null,
  };
}

/** Sanitised, interface-only fixture derived from user11 audit cases 944–979. */
export const USER11_GUIDANCE_SEQUENCE: User11GuidanceCase[] = [
  { auditCaseId: 944, spec: spec(944, 'C', 'high', [
    'User generates an idea that the current proposal is not feasible for everyone to get across.',
    'User generates idea about building infrastructure.',
  ]), currentWriting: '' },
  { auditCaseId: 949, spec: spec(949, 'C', 'high', [
    'User generates idea about outreach.', 'User wonders what kind of infrastructure is suitable.',
    'User evaluate on previous response.', 'User generates idea about cover shelters for parks and gardens.',
    'User generates idea about natural environment cooler, like when the aircon is off.',
  ]), currentWriting: '- Infrastructure: Trees, shade structures, light-coloured surfaces; provide tree canopy and shade.' },
  { auditCaseId: 956, spec: spec(956, 'C', 'high', [
    'User generate idea on centralized cooling system for residential areas.', 'User generates idea about district cooling system.',
    'User evaluates AI response and previous response.', 'User generates idea about provider guarantee for minimum temperature service.',
    'User generates idea about emergency room for people struck by heat wave.',
  ]), currentWriting: '- Shaded parks and connected walking routes.\n- District cooling system.\n- Guaranteed cool room for vulnerable residents.' },
  { auditCaseId: 961, spec: spec(961, 'C', 'high', [
    'User generates idea about shared system being cheaper, so no need for very high budget.',
    'User generates idea to prioritize the AI response on the writing section.',
    'User generates idea to focus on affordable air conditioners for everyone to install.',
    'User generates idea about long-term climate change solution, but thinks it is too long term.',
    'User feels the need for AI guidance.',
  ]), currentWriting: '- District cooling with guaranteed cool rooms, prioritising social and senior housing.' },
  { auditCaseId: 971, spec: spec(971, 'D', 'high', [
    'User evaluates AI Response 6 and 8.', 'User wants to explore creative heat wave solutions at city level.',
    'User evaluate on previous response.', 'User adopts cool route map.', 'User adopts heat refuge network.',
  ]), currentWriting: '- Cooling public spaces, heat safety information, cool-route map, district cooling, and affordable household air conditioners.' },
  { auditCaseId: 974, spec: spec(974, 'D', 'high', [
    'User adopts idea of heat refuge network.', 'User evaluates AI response and mentions papers for check escalation.',
    'User generates idea to convert buses or vans into mobile rest spaces.', 'User evaluates AI response and previous ideas.',
    'User adopts ideas from AI Response.',
  ]), currentWriting: '- Heat buddy network; cooling-on-wheels; heat passport; night refuge model; employer heat compact; heat recovery teams; shade-first infrastructure; district cooling.' },
  { auditCaseId: 979, spec: spec(979, 'C', 'high', [
    'User generate idea on resilience.', 'User generate idea on its structure.', 'User evaluates AI Response on heat-resilient infrastructure.',
    'User generates idea about car and emergency network.', 'User generates idea about passport.',
  ]), currentWriting: '- Heat buddy network, cooling-on-wheels, heat-safe housing, shade-first streets, community cooling cooperatives, heat passport, night refuge, employer heat compact, and recovery teams.' },
];
