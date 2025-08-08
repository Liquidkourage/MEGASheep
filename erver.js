* [33mf9d3c34[m[33m ([m[1;36mHEAD[m[33m -> [m[1;32mfix/esm-fetch[m[33m, [m[1;31morigin/fix/esm-fetch[m[33m)[m Server: replace require('node-fetch') with Node global fetch; fallback to dynamic import for ESM compatibility
* [33mc11efad[m[33m ([m[1;31morigin/feature/player-ui-feedback[m[33m, [m[1;32mfeature/player-ui-feedback[m[33m)[m Player UI: connection indicator, reconnection toasts, retryable submission, answer progress bar; remove debug alerts; robustness improvements
* [33m4490ab0[m[33m ([m[1;31morigin/master[m[33m, [m[1;31morigin/HEAD[m[33m, [m[1;32mmaster[m[33m)[m Fix player interface: make root URL serve game.html instead of index.html
* [33m044e9ea[m Fix dbQuestions undefined error by moving database processing inside try block
* [33md062b7a[m Fix duplicate /game route and add debugging to verify route is hit
* [33m990ea48[m Fix server routing: remove duplicate static middleware that was overriding /game route
* [33m6bfeb2d[m Add debug alert to test if game.html embedded JavaScript is being loaded
* [33mf7faf99[m Add comprehensive debugging to questionComplete event handler and answer submission
* [33mac44576[m Fix player interface waiting screen: force centering with inline styles and add debugging for answer storage
* [33mb451792[m Add IPv4 fallback and network error handling for database connections
* [33m4501ed7[m Fix public WiFi connectivity issues with IPv4 binding and increased timeouts
* [33m89c62b8[m Improve server-side error handling for fetch failures and semantic matching
* [33m823cadc[m Add error handling for sheep carousel fetch to prevent game errors
* [33m428f3b3[m Fix CSS cascade issue and add player's submitted answer to waiting screen
* [33m2968261[m Enhance waiting message centering with better styling and visual feedback
