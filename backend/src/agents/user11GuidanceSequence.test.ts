import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinalGuidanceInstruction } from '../routes/chat';
import { generateSplitGuidancePlanner } from './manipulationController';
import { USER11_GUIDANCE_SEQUENCE } from './fixtures/user11GuidanceSequence';

test('user11 fallback cases retain chronological memory and component audit traces', async () => {
  const delivered: string[] = [];
  for (const fixture of USER11_GUIDANCE_SEQUENCE) {
    const planner = await generateSplitGuidancePlanner(fixture.spec, fixture.currentWriting, async (systemPrompt) => {
      if (systemPrompt.includes('current design writing')) return JSON.stringify({ writingContextSummary: 'Existing heat-resilience mechanisms.' });
      if (systemPrompt.includes('earlier design ideas')) return JSON.stringify({ previousIdeas: fixture.spec.selectedContextMoves.map((move) => `${move.description}.`) });
      return JSON.stringify({ directionGuidance: 'Develop a new service connection from the selected ideas.' });
    });
    const finalPrompt = buildFinalGuidanceInstruction(planner, delivered, 80, fixture.spec.targetOrientation);
    assert.match(finalPrompt, /Direction:/);
    assert.match(finalPrompt, /Earlier participant ideas:/);
    assert.equal(planner.directionPlanner.status, 'success');
    assert.equal(planner.ideaExtractor.status, 'success');
    if (fixture.currentWriting) assert.equal(planner.writingSummarizer.status, 'success');
    else assert.equal(planner.writingSummarizer.status, 'skipped');
    if (delivered.length) assert.match(finalPrompt, /Earlier suggestions:/);
    delivered.push(`Simulated card ${fixture.auditCaseId}: a new coordination mechanism.`);
  }
  assert.equal(delivered.length, 7);
});
