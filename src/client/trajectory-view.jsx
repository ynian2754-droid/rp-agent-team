import {React} from './react.js'
import {services} from './client-state.js'
import {TrajectoryView} from './trajectory/TrajectoryView.tsx'
import {SnapshotTrajectory} from './trajectory/SnapshotTrajectory.tsx'
import {createTrajectorySourceRegistry} from './trajectory/source-registry.ts'
import {bindTrajectoryComponents} from './trajectory/native.ts'
import {bindRenderer} from './trajectory/renderer.ts'
import {associateTrajectory} from './trajectory/identities.js'
import {zh,en} from './trajectory/locales.ts'

export function installTrajectory(ctx, components, source, navigation) {
  bindTrajectoryComponents(components)
  bindRenderer(components)
  const registry = createTrajectorySourceRegistry(ctx)
  const stop = registry.registerSource(source)
  function TeamTrajectory(props) {
    const dictionary = /^zh/i.test(navigator.language) ? zh : en
    const translate = React.useCallback((key,values={}) => dictionary[key] === undefined ? props.t(key,values)
      : dictionary[key].replace(/\{(\w+)\}/g,(_,name)=>String(values[name]??'')),[props.t,dictionary])
    const contributions = React.useMemo(() => registry.forSession(props.sessionId), [props.sessionId])
    const nav = React.useSyncExternalStore(navigation.subscribeTrajectoryNavigation, navigation.getTrajectoryNavigationSnapshot, () => null)
    const raw = props.useTrajectory(value => value)
    const identities = props.useProjection('eleckoiInputContinuations')
    const outcomes = props.useProjection('eleckoiTurnOutcomes')
    const snapshot = React.useMemo(() => associateTrajectory(raw, identities, undefined, undefined, outcomes), [raw,identities,outcomes])
    const useTrajectory = React.useCallback(selector => selector(snapshot), [snapshot])
    return <TrajectoryView {...props} t={translate} useTrajectory={useTrajectory} contributions={contributions} sourceSessionId={props.sessionId} navigation={nav?.sessionId === props.sessionId ? nav : null} />
  }
  // Wrap the official resident body, preserving its standard hooks, children,
  // locale and product renderer. View navigation remains owned by DSH.
  const body = ctx.slots.entriesOfSlot('eleckoi.roleplay.session.body').find(entry => entry.registrant !== '@rp-team/dsh-roleplay-team')
  if (!body) throw new Error('RP Team: the official roleplay chat body slot is not registered yet.')
  function NavigationBody(props) {
    React.useEffect(() => navigation.bind(props.sessionId, props.openView), [props.sessionId, props.openView])
    return React.createElement(body.component, props)
  }
  const stopBody=ctx.slots.register({...body.options, name:'eleckoi.roleplay.session.body', priority:(body.options.priority || 0)-100, registrant:'@rp-team/dsh-roleplay-team',
    select:body.select,inject:body.inject,store:body.store,locale:body.locale}, NavigationBody)
  const view = ctx.slots.entriesOfSlot('eleckoi.roleplay.trajectory')[0]
  if (!view) {stopBody();stop();throw new Error('RP Team: the official trajectory view slot is not registered yet.')}
  function TeamTrajectorySeat(props) {
    // Owner props take precedence over slot injection. Replace the component
    // at the rendering boundary so the native owner cannot shadow our view.
    return React.createElement(view.component, { ...props, component: TeamTrajectory })
  }
  const stopView=ctx.slots.register({...view.options,name:'eleckoi.roleplay.trajectory',priority:(view.options.priority || 0)-100,registrant:'@rp-team/dsh-roleplay-team',
    select:view.select,store:view.store,locale:view.locale,
    inject:view.inject}, TeamTrajectorySeat)
  services.trajectory = {
    renderSnapshot: props => <SnapshotTrajectory {...props} conversationRuntime={components.conversationRuntime} />,
  }
  return () => {stopView();stopBody();stop();navigation.clear();services.trajectory=null}
}
