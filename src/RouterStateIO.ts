import * as T from 'fp-ts/lib/Task';
import * as O from 'fp-ts/lib/Option';
import * as H from 'history';
import * as R from 'fp-ts-routing';
import { pipe } from 'fp-ts/lib/pipeable';
import * as NQ from './util/NavigationRequest';
import * as NS from './util/NavigationResponse';
import { Parser2 } from 'react-state-io/dist/util/Parser2';
import { StateTask } from 'react-state-io/dist/util/StateTask';
import {
  AsyncCallbackRegistrar,
  SyncCallbackRegistrar,
} from 'react-state-io';
import { State } from 'fp-ts/lib/State';

const actionToNavResp = (a: H.Action): NS.NavigationResponse => {
  if (a === 'PUSH') return NS.push;
  if (a === 'POP') return NS.pop;
  return NS.replace;
};

/**
 * A router that transforms global state
 * (uses `createBrowserHistory` from {@link https://github.com/ReactTraining/history#readme history} under the hood)
 * 
 * @template S - Global app state
 * @template P - Parameterizes the Async Side Effect Handler with a NavRequest.
 * @template R - Logical route type
 * @param parser - Converts a {@link https://gcanti.github.io/fp-ts-routing/modules/index.ts.html#route-class Route} into R
 * @param unParser - Converts R into a path string
 * @param notFoundRoute - R to use when parser can't find any
 * @param defaultStateFromRoute - Populates app's global state before component is mounted using routing data
 * @param newStateFromRoute - Callback on component mount and route change
 * @param conditionallyBlockTransition - Conditionally {@link https://github.com/ReactTraining/history/blob/master/docs/Blocking.md register a prompt message} to make sure the user wants to leave the current page before they navigate away
 * @returns an object of types that hook into 'withGlobalSideEffects'
 */
const routerStateIO = <S, P, R>(
  parser: R.Parser<R>,
  unParser: (r: R) => string,
  notFoundRoute: R,
  extractNavRequest: Parser2<P, NQ.NavigationRequest<R>>,
  defaultStateFromRoute: (navResponse: NS.NavigationResponse, route: R) => S,
  newStateFromRoute: (route: R) => (navResponse: NS.NavigationResponse) => StateTask<S, O.Option<P>>,
  conditionallyBlockTransition?: (appState: S, navResponse: NS.NavigationResponse) => (route: R) => string | undefined,
): {
  defaultState: S;
  syncSideEffect: (p: P) => State<() => S, O.Option<P>>;
  onMount: StateTask<() => S, O.Option<P>>;
  asyncCallbackRegistrar: AsyncCallbackRegistrar<
    S, P, [H.Location<H.LocationState>, H.Action]
  >;
  syncCallbackRegistrar?: SyncCallbackRegistrar<
    S, P, [H.Location<H.LocationState>, H.Action], string | undefined
  >;
} => {
  const history = H.createBrowserHistory();
  const handleNavRequest = NQ.fold<R, void>(
    (route) => history.push(unParser(route).toString()),
    (route) => history.replace(unParser(route).toString()),
    (route) => history.push(route),
    (route) => history.replace(route),
    (numSessions) => history.go(numSessions),
    () => history.goBack(),
    () => history.goForward(),
  );
  return {
    defaultState: defaultStateFromRoute(
      actionToNavResp(history.action),
      R.parse(parser, R.Route.parse(history.location.pathname), notFoundRoute)
    ),
    syncSideEffect: (param: P) => (s): [O.Option<P>, () => S] => pipe(
      extractNavRequest.run(param),
      O.map(([someNavRequest, param]): [O.Option<P>, () => S] => {
        handleNavRequest(someNavRequest)
        return [O.some(param), s];
      }),
      O.getOrElse<[O.Option<P>, () => S]>(() => [O.some(param), s]),
    ),
    onMount: (stateThunk): T.Task<[O.Option<P>, () => S]> => {
      const route = R.parse(
        parser,
        R.Route.parse(history.location.pathname),
        notFoundRoute
      );
      return pipe(
        newStateFromRoute(route)(
          actionToNavResp(history.action)
        )(
          stateThunk(),
        ),
        T.map(([param, s]): [O.Option<P>, () => S] => pipe(
          param,
          O.chain((someParam) => pipe(
            extractNavRequest.run(someParam),
            O.map(([navRequest, param]): [O.Option<P>, () => S] => {
              handleNavRequest(navRequest);
              return [O.some(param), (): S => s];
            }),
          )),
          O.getOrElse<[O.Option<P>, () => S]>(() => [param, (): S => s]),
        )),
      );
    },
    asyncCallbackRegistrar: {
      registerCallback: history.listen,
      callbackWithStateToAsyncState: (
        location, action,
      ) => (
        stateThunk
      ): T.Task<[O.Option<P>, () => S]> => {
        const route = R.parse(
          parser,
          R.Route.parse(location.pathname),
          notFoundRoute
        );
        const f = pipe(
          newStateFromRoute(route)(
            actionToNavResp(action),
          )(
            stateThunk(),
          ),
          T.map(([param, s]): [O.Option<P>, () => S] => {
            return pipe(
              param,
              O.chain(extractNavRequest.run),
              O.map(([navRequest, someParam]): [O.Option<P>, () => S] => {
                handleNavRequest(navRequest);
                return [O.some(someParam), (): S => s];
              }),
              O.getOrElse<[O.Option<P>, () => S]>(() => [param, (): S => s]),
            );
          }),
        )
        return f;
      },
    },
    syncCallbackRegistrar: conditionallyBlockTransition && {
      registerCallback: history.block,
      stateToRetVal: (
        stateThunk, 
        location,
        action,
      ): string | undefined => {
        const route = R.parse(
          parser,
          R.Route.parse(location.pathname),
          notFoundRoute
        );
        return conditionallyBlockTransition(
          stateThunk(),
          actionToNavResp(action), 
        )(route);
      },
    },
  };
};

export default routerStateIO;
