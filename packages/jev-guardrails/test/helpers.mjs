/** Shared fake transport helpers for the library tests. */

export function noulAnswer(noul) {
  return { type: 'noul', noul }
}

export function scoreAnswer(score, confidence = 0.9) {
  return {
    type: 'score',
    score,
    confidence,
    legend: { 0: 'none', 1: 'mild', 2: 'serious', 3: 'severe' },
    probabilities: { 0: 0.1, 1: 0.1, 2: 0.3, 3: 0.5 },
  }
}

export function choiceAnswer(choice, probabilities, confidence = 0.9) {
  return { type: 'choice', choice, confidence, probabilities }
}

/**
 * Build a fake Jev transport.
 *
 * `answerFor` may be a function `(key, request, question) => answer` or an
 * object keyed by question id.
 */
export function fakeTransport({ answerFor, model = 'fake-jev', usage } = {}) {
  const calls = []
  return {
    calls,
    async systemOne(request, options) {
      calls.push({ request, options })
      const answers = {}
      for (const [key, question] of Object.entries(request.questions)) {
        answers[key] =
          typeof answerFor === 'function'
            ? answerFor(key, request, question)
            : answerFor?.[key] ?? defaultAnswer(question)
      }
      return {
        model,
        answers,
        usage: usage ?? { input_tokens: 10, output_tokens: 5 },
      }
    },
  }
}

function defaultAnswer(question) {
  if (question.type === 'noul') return noulAnswer(0.01)
  if (question.type === 'score') return scoreAnswer(0, 0.95)
  const criteria = Object.keys(question.criteria)
  return choiceAnswer(criteria[0], Object.fromEntries(criteria.map((key) => [key, 1 / criteria.length])), 0.9)
}
