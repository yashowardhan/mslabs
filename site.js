(function () {
  'use strict';

  var CONFIG = {
    email: 'contact@mslabsstudio.com',
    formEndpoint: 'https://formsubmit.co/ajax/contact@mslabsstudio.com'
  };

  var labels = {
    check: 'Free site check',
    essential: 'Care Essential',
    plus: 'Care Plus',
    pro: 'Care Pro',
    fix: 'One-time fix',
    agency: 'Agency partnership',
    project: 'Custom development project',
    capacity: 'Ongoing engineering capacity'
  };

  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

  var toggle = document.getElementById('nav-toggle');
  var links = document.getElementById('nav-links');
  if (toggle && links) {
    function closeMenu() {
      links.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    }
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    links.addEventListener('click', function (e) {
      if (e.target.closest('a')) closeMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });
  }

  var form = document.getElementById('contact-form');
  if (!form) return;
  var status = document.getElementById('form-status');

  function setStatus(message, kind) {
    if (!status) return;
    status.textContent = message;
    status.className = 'form-status' + (kind ? ' is-' + kind : '');
  }

  document.querySelectorAll('[data-interest]').forEach(function (el) {
    el.addEventListener('click', function () {
      var select = form.elements.interest;
      var value = el.getAttribute('data-interest');
      if (select && labels[value]) select.value = value;
      var note = el.getAttribute('data-note');
      if (note && form.elements.message && !form.elements.message.value.trim()) {
        form.elements.message.value = "I'm interested in: " + note + '.';
      }
    });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();

    var honeypot = form.elements.website_url_trap;
    if (honeypot && honeypot.value) return;

    if (!form.elements.name.value.trim() || !form.elements.email.validity.valid || !form.elements.email.value.trim()) {
      setStatus('Please enter your name and a valid email address.', 'error');
      return;
    }

    var website = form.elements.website;
    if (website && website.value && !website.validity.valid) {
      setStatus('Please enter the website address in full, starting with https://', 'error');
      return;
    }

    var interest = labels[form.elements.interest.value] || 'Enquiry';
    var submit = form.querySelector('button[type="submit"]');
    if (submit) submit.disabled = true;
    setStatus('Sending…', '');

    var data = new FormData(form);
    data.append('_subject', 'MS Labs enquiry: ' + interest);
    data.append('_captcha', 'false');
    data.append('_template', 'table');

    fetch(CONFIG.formEndpoint, {
      method: 'POST',
      body: data,
      headers: { 'Accept': 'application/json' }
    }).then(function (response) {
      if (!response.ok) throw new Error('Request failed');
      form.reset();
      setStatus('Thanks — your enquiry has been sent. I’ll reply within 1 business day.', 'ok');
    }).catch(function () {
      setStatus('The form could not be sent. Please email ' + CONFIG.email + ' directly.', 'error');
    }).finally(function () {
      if (submit) submit.disabled = false;
    });
  });
})();
