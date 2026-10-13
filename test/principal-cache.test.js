import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrincipalCache } from '../src/oauth/principal-cache.js';

const principal = (over = {}) => ({ subject: 'ruben', scopes: ['vault:read'], expiresAt: Math.floor(Date.now() / 1000) + 600, ...over });

test('gibt einen abgelegten Principal synchron zurück', () => {
  const c = createPrincipalCache();
  c.put('tok', principal());
  assert.equal(c.get('tok').subject, 'ruben');
});

test('kennt unbekannte Tokens nicht', () => {
  assert.equal(createPrincipalCache().get('fremd'), null);
});

test('gibt einen abgelaufenen Principal nicht mehr heraus', () => {
  const c = createPrincipalCache();
  c.put('tok', principal({ expiresAt: Math.floor(Date.now() / 1000) - 1 }));
  assert.equal(c.get('tok'), null, 'die Token-Lebensdauer begrenzt auch den Cache');
});

test('räumt abgelaufene Einträge auf, statt zu wachsen', () => {
  const c = createPrincipalCache();
  const abgelaufen = Math.floor(Date.now() / 1000) - 1;
  for (let i = 0; i < 50; i++) c.put(`alt${i}`, principal({ expiresAt: abgelaufen }));
  c.put('frisch', principal());
  c.sweep();
  assert.equal(c.size(), 1);
  assert.ok(c.get('frisch'));
});

test('unterscheidet Tokens voneinander', () => {
  const c = createPrincipalCache();
  c.put('a', principal({ subject: 'ruben' }));
  c.put('b', principal({ subject: 'jemand-anderes' }));
  assert.equal(c.get('a').subject, 'ruben');
  assert.equal(c.get('b').subject, 'jemand-anderes');
});
