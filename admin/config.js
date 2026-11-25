/*
  Editor settings. Nothing in here is secret: the GitHub client ID is public by design,
  and the sign-in helper keeps the real secret on Cloudflare.
*/
window.EDITOR_CONFIG = {
  owner: 'applehugger',          // GitHub account that owns the site repository
  repo: 'applehugger',           // repository name
  branch: 'main',                // publishing to main makes changes live
  allowedLogin: 'applehugger',   // the only GitHub account allowed to edit
  authUrl: 'https://applehugger-auth.applehugger.workers.dev', // sign-in helper on Cloudflare
};
