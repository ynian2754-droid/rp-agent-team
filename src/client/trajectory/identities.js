/** Official input identities, never timestamps or reusable sequence alone. */
export function associateTrajectory(snapshot, identities, run, sessionId, outcomes) {
  const inputs = identities?.inputs || snapshot.eventNodes.filter(node => node.kind === 'user' && node.messageId)
    .map(node => ({turn: snapshot.eventLocations.get(node.seq)?.turn?.turn, eventSeq:node.seq,messageId:node.messageId}))
  const bySeq = new Map(inputs.map(input => [input.eventSeq,input]))
  const inputTurns = new Map(snapshot.inputTurns || [])
  const turnLabels = new Map(snapshot.turnLabels || [])
  const labelsByMessage = new Map()
  const turns = new Map()
  const nativeTurns = new Map((snapshot.turnEvents || []).map(event => [event.turn,event]))
  const aborted = new Set(outcomes?.abortedTurns || [])
  const turnEvent = (turn,input) => ({...nativeTurns.get(turn),turn,inputMessageId:input.messageId,
    inputEventSeq:input.eventSeq,startSeq:nativeTurns.get(turn)?.startSeq ?? input.eventSeq,
    status:aborted.has(turn) ? 'aborted' : nativeTurns.get(turn)?.status ?? 'unknown'})
  for (const input of [...inputs].sort((a,b)=>a.eventSeq-b.eventSeq)) if (input.turn > 0) {
    if (!labelsByMessage.has(input.messageId)) labelsByMessage.set(input.messageId, labelsByMessage.size + 1)
    turnLabels.set(input.turn,labelsByMessage.get(input.messageId))
    inputTurns.set(input.eventSeq,input.turn)
    turns.set(input.turn,turnEvent(input.turn,input))
  }
  for(const link of identities?.links || []) {
    const input=bySeq.get(link.inputEventSeq)
    if(input?.messageId!==link.inputMessageId) continue
    turnLabels.set(link.turn,labelsByMessage.get(input.messageId))
    inputTurns.set(input.eventSeq,link.turn)
    turns.set(link.turn,turnEvent(link.turn,input))
  }
  const records=(run?.events || []).filter(event=>event.type==='model.input' && event.data.sessionId===sessionId)
  const requests=snapshot.requests.map(request=>{
    const entry=records.find(event=>event.data.turn===request.turn && event.data.step===request.step)
    return entry ? {...request,context:entry.data.context}:request
  })
  return {...snapshot,inputTurns,turnLabels,turnEvents:[...turns.values()],requests}
}
