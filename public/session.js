// Part 18: the signed-in pill in the header, and back to the sign-in page when the session ends.
// A classic script that runs before app.js, so every fetch the page makes (the live stream included) is covered.
// textContent only.
(() => {
  const nativeFetch = window.fetch.bind(window);
  let leaving = false;
  const toSignIn = () => {
    if (leaving) return;
    leaving = true;
    const next = location.pathname + location.search;
    location.assign(`/signin?${new URLSearchParams({ next, e: 'expired' })}`);
  };
  window.fetch = async (input, init) => {
    const res = await nativeFetch(input, init);
    if (res.status === 401) {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.origin === location.origin && /^\/(api|auth)\//.test(url.pathname)) toSignIn();
    }
    return res;
  };
  const show = async () => {
    const pill = document.getElementById('who');
    if (!pill) return;
    try {
      const me = await (await nativeFetch('/auth/me', { cache: 'no-store' })).json();
      if (!me.auth || !me.username) return; // sign-in is off (local demo): no pill
      pill.querySelector('.who-name').textContent = me.username;
      pill.querySelector('.who-av').textContent = me.username.slice(0, 1).toUpperCase();
      pill.hidden = false;
    } catch { /* the pill is a nicety; the page works without it */ }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
})();
