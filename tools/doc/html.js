'use strict';

const common = require('./common.js');
const fs = require('fs');
const marked = require('marked');
const path = require('path');
const preprocess = require('./preprocess.js');
const typeParser = require('./type-parser.js');

module.exports = toHTML;

const STABILITY_TEXT_REG_EXP = /(.*:)\s*(\d)([\s\S]*)/;

// customized heading without id attribute
var renderer = new marked.Renderer();
renderer.heading = function(text, level) {
  return '<h' + level + '>' + text + '</h' + level + '>\n';
};
marked.setOptions({
  renderer: renderer
});

// TODO(chrisdickinson): never stop vomitting / fix this.
var gtocPath = path.resolve(path.join(
  __dirname,
  '..',
  '..',
  'doc',
  'api',
  '_toc.md'
));
var gtocLoading = null;
var gtocData = null;

/**
 * opts: input, filename, template, nodeVersion.
 */
function toHTML(opts, cb) {
  var template = opts.template;
  var nodeVersion = opts.nodeVersion || process.version;

  if (gtocData) {
    return onGtocLoaded();
  }

  if (gtocLoading === null) {
    gtocLoading = [onGtocLoaded];
    return loadGtoc(function(err, data) {
      if (err) throw err;
      gtocData = data;
      gtocLoading.forEach(function(xs) {
        xs();
      });
    });
  }

  if (gtocLoading) {
    return gtocLoading.push(onGtocLoaded);
  }

  function onGtocLoaded() {
    var lexed = marked.lexer(opts.input);
    fs.readFile(template, 'utf8', function(er, template) {
      if (er) return cb(er);
      render({
        lexed: lexed,
        filename: opts.filename,
        template: template,
        nodeVersion: nodeVersion,
      }, cb);
    });
  }
}

function loadGtoc(cb) {
  fs.readFile(gtocPath, 'utf8', function(err, data) {
    if (err) return cb(err);

    preprocess(gtocPath, data, function(err, data) {
      if (err) return cb(err);

      data = marked(data).replace(/<a href="(.*?)"/gm, function(a, m) {
        return '<a class="nav-' + toID(m) + '" href="' + m + '"';
      });
      return cb(null, data);
    });
  });
}

function toID(filename) {
  return filename
    .replace('.html', '')
    .replace(/[^\w-]/g, '-')
    .replace(/-+/g, '-');
}

/**
 * opts: lexed, filename, template, nodeVersion.
 */
function render(opts, cb) {
  var lexed = opts.lexed;
  var filename = opts.filename;
  var template = opts.template;
  var nodeVersion = opts.nodeVersion || process.version;

  // get the section
  var section = getSection(lexed);

  filename = path.basename(filename, '.md');

  parseText(lexed);
  lexed = parseLists(lexed);

  // generate the table of contents.
  // this mutates the lexed contents in-place.
  buildToc(lexed, filename, function(er, toc) {
    if (er) return cb(er);

    var id = toID(path.basename(filename));

    template = template.replace(/__ID__/g, id);
    template = template.replace(/__FILENAME__/g, filename);
    template = template.replace(/__SECTION__/g, section || 'Index');
    template = template.replace(/__VERSION__/g, nodeVersion);
    template = template.replace(/__TOC__/g, toc);
    template = template.replace(
      /__GTOC__/g,
      gtocData.replace('class="nav-' + id, 'class="nav-' + id + ' active')
    );

    // content has to be the last thing we do with
    // the lexed tokens, because it's destructive.
    const content = marked.parser(lexed);
    template = template.replace(/__CONTENT__/g, content);

    cb(null, template);
  });
}

// handle general body-text replacements
// for example, link man page references to the actual page
function parseText(lexed) {
  lexed.forEach(function(tok) {
    if (tok.text && tok.type !== 'code') {
      tok.text = linkManPages(tok.text);
      tok.text = linkJsTypeDocs(tok.text);
    }
  });
}

// just update the list item text in-place.
// lists that come right after a heading are what we're after.
function parseLists(input) {
  var state = null;
  var savedState = [];
  var depth = 0;
  var output = [];
  let headingIndex = -1;
  let heading = null;

  output.links = input.links;
  input.forEach(function(tok, index) {
    if (tok.type === 'blockquote_start') {
      savedState.push(state);
      state = 'MAYBE_STABILITY_BQ';
      return;
    }
    if (tok.type === 'blockquote_end' && state === 'MAYBE_STABILITY_BQ') {
      state = savedState.pop();
      return;
    }
    if ((tok.type === 'paragraph' && state === 'MAYBE_STABILITY_BQ') ||
      tok.type === 'code') {
      if (tok.text.match(/Stability:.*/g)) {
        const stabilityMatch = tok.text.match(STABILITY_TEXT_REG_EXP);
        const stability = Number(stabilityMatch[2]);
        const isStabilityIndex =
          index - 2 === headingIndex || // general
          index - 3 === headingIndex;   // with api_metadata block

        if (heading && isStabilityIndex) {
          heading.stability = stability;
          headingIndex = -1;
          heading = null;
        }
        tok.text = parseAPIHeader(tok.text);
        output.push({ type: 'html', text: tok.text });
        return;
      } else if (state === 'MAYBE_STABILITY_BQ') {
        output.push({ type: 'blockquote_start' });
        state = savedState.pop();
      }
    }
    if (state === null ||
      (state === 'AFTERHEADING' && tok.type === 'heading')) {
      if (tok.type === 'heading') {
        headingIndex = index;
        heading = tok;
        state = 'AFTERHEADING';
      }
      output.push(tok);
      return;
    }
    if (state === 'AFTERHEADING') {
      if (tok.type === 'list_start') {
        state = 'LIST';
        if (depth === 0) {
          output.push({ type: 'html', text: '<div class="signature">' });
        }
        depth++;
        output.push(tok);
        return;
      }
      if (tok.type === 'html' && common.isYAMLBlock(tok.text)) {
        tok.text = parseYAML(tok.text);
      }
      state = null;
      output.push(tok);
      return;
    }
    if (state === 'LIST') {
      if (tok.type === 'list_start') {
        depth++;
        output.push(tok);
        return;
      }
      if (tok.type === 'list_end') {
        depth--;
        output.push(tok);
        if (depth === 0) {
          state = null;
          output.push({ type: 'html', text: '</div>' });
        }
        return;
      }
    }
    output.push(tok);
  });

  return output;
}

function parseYAML(text) {
  const meta = common.extractAndParseYAML(text);
  const html = ['<div class="api_metadata">'];

  if (meta.added) {
    html.push(`<span>Added in: ${meta.added.join(', ')}</span>`);
  }

  if (meta.deprecated) {
    html.push(`<span>Deprecated since: ${meta.deprecated.join(', ')} </span>`);
  }

  html.push('</div>');
  return html.join('\n');
}

// Syscalls which appear in the docs, but which only exist in BSD / OSX
var BSD_ONLY_SYSCALLS = new Set(['lchmod']);

// Handle references to man pages, eg "open(2)" or "lchmod(2)"
// Returns modified text, with such refs replace with HTML links, for example
// '<a href="http://man7.org/linux/man-pages/man2/open.2.html">open(2)</a>'
function linkManPages(text) {
  return text.replace(/ ([a-z.]+)\((\d)\)/gm, function(match, name, number) {
    // name consists of lowercase letters, number is a single digit
    var displayAs = name + '(' + number + ')';
    if (BSD_ONLY_SYSCALLS.has(name)) {
      return ' <a href="https://www.freebsd.org/cgi/man.cgi?query=' + name +
             '&sektion=' + number + '">' + displayAs + '</a>';
    } else {
      return ' <a href="http://man7.org/linux/man-pages/man' + number +
             '/' + name + '.' + number + '.html">' + displayAs + '</a>';
    }
  });
}

function linkJsTypeDocs(text) {
  var parts = text.split('`');
  var i;
  var typeMatches;

  // Handle types, for example the source Markdown might say
  // "This argument should be a {Number} or {String}"
  for (i = 0; i < parts.length; i += 2) {
    typeMatches = parts[i].match(/\{([^}]+)\}/g);
    if (typeMatches) {
      typeMatches.forEach(function(typeMatch) {
        parts[i] = parts[i].replace(typeMatch, typeParser.toLink(typeMatch));
      });
    }
  }

  //XXX maybe put more stuff here?
  return parts.join('`');
}

function parseAPIHeader(text) {
  text = text.replace(
    STABILITY_TEXT_REG_EXP,
    '<pre class="api_stability api_stability_$2">$1 $2$3</pre>'
  );
  return text;
}

// section is just the first heading
function getSection(lexed) {
  for (var i = 0, l = lexed.length; i < l; i++) {
    var tok = lexed[i];
    if (tok.type === 'heading') return tok.text;
  }
  return '';
}


function buildToc(lexed, filename, cb) {
  var toc = [];
  var depth = 0;

  const startIncludeRefRE = /^\s*<!-- \[start-include:(.+)\] -->\s*$/;
  const endIncludeRefRE = /^\s*<!-- \[end-include:(.+)\] -->\s*$/;
  const realFilenames = [filename];

  lexed.forEach(function(tok) {
    // Keep track of the current filename along @include directives.
    if (tok.type === 'html') {
      let match;
      if ((match = tok.text.match(startIncludeRefRE)) !== null)
        realFilenames.unshift(match[1]);
      else if (tok.text.match(endIncludeRefRE))
        realFilenames.shift();
    }

    if (tok.type !== 'heading') return;
    if (tok.depth - depth > 1) {
      return cb(new Error('Inappropriate heading level\n' +
                          JSON.stringify(tok)));
    }

    depth = tok.depth;
    const realFilename = path.basename(realFilenames[0], '.md');
    const id = getId(realFilename + '_' + tok.text.trim());
    toc.push(new Array((depth - 1) * 2 + 1).join(' ') +
             '* <span class="stability_' + tok.stability + '">' +
             '<a href="#' + id + '">' + tok.text + '</a></span>');
    tok.text += '<span><a class="mark" href="#' + id + '" ' +
                'id="' + id + '">#</a></span>';
  });

  toc = marked.parse(toc.join('\n'));
  cb(null, toc);
}

var idCounters = {};
function getId(text) {
  text = text.toLowerCase();
  text = text.replace(/[^a-z0-9]+/g, '_');
  text = text.replace(/^_+|_+$/, '');
  text = text.replace(/^([^a-z])/, '_$1');
  if (idCounters.hasOwnProperty(text)) {
    text += '_' + (++idCounters[text]);
  } else {
    idCounters[text] = 0;
  }
  return text;
}
