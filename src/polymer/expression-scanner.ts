/**
 * @license
 * Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */

import * as dom5 from 'dom5';
import * as estree from 'estree';
import * as parse5 from 'parse5';

import {ParsedHtmlDocument} from '../html/html-document';
import {JavaScriptDocument} from '../javascript/javascript-document';
import {parseJs} from '../javascript/javascript-parser';
import {correctSourceRange, LocationOffset, Severity, SourceRange, Warning} from '../model/model';


const p = dom5.predicates;
const isTemplate = p.hasTagName('template');

const isDataBindingTemplate = p.AND(
    isTemplate,
    p.OR(
        p.hasAttrValue('is', 'dom-bind'),
        p.hasAttrValue('is', 'dom-if'),
        p.hasAttrValue('is', 'dom-repeat'),
        p.parentMatches(p.OR(
            p.hasTagName('dom-bind'),
            p.hasTagName('dom-if'),
            p.hasTagName('dom-repeat'),
            p.hasTagName('dom-module')))));

export interface Template extends parse5.ASTNode { content: parse5.ASTNode; }

/**
 * Given a node, return all databinding templates inside it.
 *
 * A template is "databinding" if polymer databinding expressions are expected
 * to be evaluated inside. e.g. <template is='dom-if'> or <dom-module><template>
 *
 * Results include both direct and nested templates (e.g. dom-if inside
 * dom-module).
 */
export function getAllDataBindingTemplates(node: parse5.ASTNode) {
  return dom5.queryAll(
      node,
      isDataBindingTemplate,
      [],
      dom5.childNodesIncludeTemplate) as Template[];
}

export type HtmlDatabindingExpression =
    TextNodeDatabindingExpression | AttributeDatabindingExpression;
export abstract class DatabindingExpression {
  readonly sourceRange: SourceRange;
  readonly warnings: Warning[] = [];
  readonly expressionText: string;

  private readonly _expressionAst: estree.Program;
  private readonly locationOffset: LocationOffset;

  /**
   * Toplevel properties on the model that are referenced in this expression.
   *
   * e.g. in {{foo(bar, baz.zod)}} the properties are foo, bar, and baz
   * (but not zod).
   */
  properties: Array<{name: string, sourceRange: SourceRange}> = [];

  constructor(
      sourceRange: SourceRange, expressionText: string, ast: estree.Program) {
    this.sourceRange = sourceRange;
    this.expressionText = expressionText;
    this._expressionAst = ast;
    this.locationOffset = {
      line: sourceRange.start.line,
      col: sourceRange.start.column
    };

    this._extractPropertiesAndValidate();
  }

  /**
   * Given an estree node in this databinding expression, give its source range.
   */
  sourceRangeForNode(node: estree.Node) {
    if (!node || !node.loc) {
      return;
    }
    const databindingRelativeSourceRange = {
      file: this.sourceRange.file,
      // Note: estree uses 1-indexed lines, but SourceRange uses 0 indexed.
      start: {line: (node.loc.start.line - 1), column: node.loc.start.column},
      end: {line: (node.loc.end.line - 1), column: node.loc.end.column}
    };
    return correctSourceRange(
        databindingRelativeSourceRange, this.locationOffset);
  }

  private _extractPropertiesAndValidate() {
    if (this._expressionAst.body.length !== 1) {
      this.warnings.push(this._validationWarning(
          `Expected one expression, got ${this._expressionAst.body.length}`,
          this._expressionAst));
      return;
    }
    const expressionStatement = this._expressionAst.body[0]!;
    if (expressionStatement.type !== 'ExpressionStatement') {
      this.warnings.push(this._validationWarning(
          `Expect an expression, not a ${expressionStatement.type}`,
          expressionStatement));
      return;
    }
    let expression = expressionStatement.expression;
    if (expression.type === 'UnaryExpression') {
      if (expression.operator !== '!') {
        this.warnings.push(this._validationWarning(
            'Only the logical not (!) operator is supported.', expression));
        return;
      }
      expression = expression.argument;
    }
    this._extractAndValidateSubExpression(expression, true);
  }

  private _extractAndValidateSubExpression(
      expression: estree.Node, callAllowed: boolean) {
    if (expression.type === 'Literal') {
      return;
    }
    if (expression.type === 'Identifier') {
      this.properties.push({
        name: expression.name,
        sourceRange: this.sourceRangeForNode(expression)!
      });
      return;
    }
    if (expression.type === 'MemberExpression') {
      this._extractAndValidateSubExpression(expression.object, false);
      return;
    }
    if (callAllowed && expression.type === 'CallExpression') {
      this._extractAndValidateSubExpression(expression.callee, false);
      for (const arg of expression.arguments) {
        this._extractAndValidateSubExpression(arg, false);
      }
      return;
    }
    this.warnings.push(this._validationWarning(
        `Only simple syntax is supported in Polymer databinding expressions. ` +
            `${expression.type} not expected here.`,
        expression));
  }

  private _validationWarning(message: string, node: estree.Node): Warning {
    return {
      code: 'invalid-polymer-expression',
      message,
      sourceRange: this.sourceRangeForNode(node)!,
      severity: Severity.WARNING
    };
  }
}

export class AttributeDatabindingExpression extends DatabindingExpression {
  /**
   * The element whose attribute/property is assigned to.
   */
  readonly astNode: parse5.ASTNode;

  readonly databindingInto = 'attribute';

  /**
   * If true, this is databinding into the complete attribute. Polymer treats
   * such databindings specially, e.g. they're setting the property by default,
   * not the attribute.
   *
   * e.g.
   * foo="{{bar}}" is complete, foo="hello {{bar}} world" is not complete.
   *
   * An attribute may have multiple incomplete bindings. They will be separate
   * AttributeDatabindingExpressions.
   */
  readonly isCompleteBinding: boolean;

  /** The databinding syntax used. */
  readonly direction: '{'|'[';

  /**
   * If this is a two-way data binding, and an event name was specified
   * (using ::eventName syntax), this is that event name.
   */
  readonly eventName: string|undefined;

  /** The attribute we're databinding into. */
  readonly attribute: parse5.ASTAttribute;

  constructor(
      astNode: parse5.ASTNode, isCompleteBinding: boolean, direction: '{'|'[',
      eventName: string|undefined, attribute: parse5.ASTAttribute,
      sourceRange: SourceRange, expressionText: string, ast: estree.Program) {
    super(sourceRange, expressionText, ast);
    this.astNode = astNode;
    this.isCompleteBinding = isCompleteBinding;
    this.direction = direction;
    this.eventName = eventName;
    this.attribute = attribute;
  }
}

export class TextNodeDatabindingExpression extends DatabindingExpression {
  /** The databinding syntax used. */
  readonly direction: '{'|'[';

  /**
   * The HTML text node that contains this databinding.
   */
  readonly astNode: parse5.ASTNode;

  readonly databindingInto = 'text-node';

  constructor(
      direction: '{'|'[', astNode: parse5.ASTNode, sourceRange: SourceRange,
      expressionText: string, ast: estree.Program) {
    super(sourceRange, expressionText, ast);
    this.direction = direction;
    this.astNode = astNode;
  }
}

export class JavascriptDatabindingExpression extends DatabindingExpression {
  readonly astNode: estree.Node;

  readonly databindingInto = 'javascript';

  constructor(
      astNode: estree.Node, sourceRange: SourceRange, expressionText: string,
      ast: estree.Program) {
    super(sourceRange, expressionText, ast);
    this.astNode = astNode;
  }
}

/**
 * Find and parse Polymer databinding expressions in HTML.
 */
export function scanDocumentForExpressions(document: ParsedHtmlDocument) {
  return extractDataBindingsFromTemplates(
      document, getAllDataBindingTemplates(document.ast));
}

export function scanDatabindingTemplateForExpressions(
    document: ParsedHtmlDocument, template: Template) {
  return extractDataBindingsFromTemplates(
      document,
      [template].concat(getAllDataBindingTemplates(template.content)));
}

function extractDataBindingsFromTemplates(
    document: ParsedHtmlDocument, templates: Iterable<Template>) {
  const results: HtmlDatabindingExpression[] = [];
  const warnings: Warning[] = [];
  for (const template of templates) {
    dom5.nodeWalkAll(template.content, (node) => {
      if (dom5.isTextNode(node) && node.value) {
        extractDataBindingsFromTextNode(document, node, results, warnings);
      }
      if (node.attrs) {
        for (const attr of node.attrs) {
          extractDataBindingsFromAttr(document, node, attr, results, warnings);
        }
      }
      return false;
    });
  }
  return {expressions: results, warnings};
}

function extractDataBindingsFromTextNode(
    document: ParsedHtmlDocument,
    node: parse5.ASTNode,
    results: HtmlDatabindingExpression[],
    warnings: Warning[]) {
  const text = node.value || '';
  const dataBindings = findDatabindingInString(text);
  if (dataBindings.length === 0) {
    return;
  }
  const newlineIndexes = findNewlineIndexes(text);
  const nodeSourceRange = document.sourceRangeForNode(node);
  if (!nodeSourceRange) {
    return;
  }
  // We have indexes into the text node, we'll want to correct that so that
  // it's a range relative to the start of the document.
  const startOfTextNodeOffset: LocationOffset = {
    line: nodeSourceRange.start.line,
    col: nodeSourceRange.start.column
  };
  for (const dataBinding of dataBindings) {
    const sourceRangeWithinTextNode = indexesToSourceRange(
        dataBinding.startIndex,
        dataBinding.endIndex,
        nodeSourceRange.file,
        newlineIndexes);
    const sourceRange =
        correctSourceRange(sourceRangeWithinTextNode, startOfTextNodeOffset)!;

    const parseResult =
        parseExpression(dataBinding.expressionText, sourceRange);

    if (!parseResult) {
      continue;
    }
    if (parseResult.type === 'failure') {
      warnings.push(parseResult.warning);
    } else {
      const expression = new TextNodeDatabindingExpression(
          dataBinding.direction,
          node,
          sourceRange,
          dataBinding.expressionText,
          parseResult.program);
      for (const warning of expression.warnings) {
        warnings.push(warning);
      }
      results.push(expression);
    }

    ;
  }
}

function extractDataBindingsFromAttr(
    document: ParsedHtmlDocument,
    node: parse5.ASTNode,
    attr: parse5.ASTAttribute,
    results: HtmlDatabindingExpression[],
    warnings: Warning[]) {
  if (!attr.value) {
    return;
  }
  const dataBindings = findDatabindingInString(attr.value);
  const attributeValueRange =
      document.sourceRangeForAttributeValue(node, attr.name, true);
  if (!attributeValueRange) {
    return;
  }
  const attributeOffset: LocationOffset = {
    line: attributeValueRange.start.line,
    col: attributeValueRange.start.column
  };
  const newlineIndexes = findNewlineIndexes(attr.value);
  for (const dataBinding of dataBindings) {
    const isFullAttributeBinding = dataBinding.startIndex === 2 &&
        dataBinding.endIndex + 2 === attr.value.length;
    let expressionText = dataBinding.expressionText;
    let eventName = undefined;
    if (dataBinding.direction === '{') {
      const match = expressionText.match(/(.*)::(.*)/);
      if (match) {
        expressionText = match[1];
        eventName = match[2];
      }
    }
    const sourceRangeWithinAttribute = indexesToSourceRange(
        dataBinding.startIndex,
        dataBinding.endIndex,
        attributeValueRange.file,
        newlineIndexes);
    const sourceRange =
        correctSourceRange(sourceRangeWithinAttribute, attributeOffset)!;
    const parseResult = parseExpression(expressionText, sourceRange);
    if (!parseResult) {
      continue;
    }
    if (parseResult.type === 'failure') {
      warnings.push(parseResult.warning);
    } else {
      const expression = new AttributeDatabindingExpression(
          node,
          isFullAttributeBinding,
          dataBinding.direction,
          eventName,
          attr,
          sourceRange,
          expressionText,
          parseResult.program);
      for (const warning of expression.warnings) {
        warnings.push(warning);
      }
      results.push(expression);
    }
  }
}

interface RawDatabinding {
  readonly expressionText: string;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly direction: '{'|'[';
}
function findDatabindingInString(str: string) {
  const expressions: RawDatabinding[] = [];
  const openers = /{{|\[\[/g;
  let match;
  while (match = openers.exec(str)) {
    const matchedOpeners = match[0];
    const startIndex = match.index + 2;
    const direction = matchedOpeners === '{{' ? '{' : '[';
    const closers = matchedOpeners === '{{' ? '}}' : ']]';
    const endIndex = str.indexOf(closers, startIndex);
    if (endIndex === -1) {
      // No closers, this wasn't an expression after all.
      break;
    }
    const expressionText = str.slice(startIndex, endIndex);
    expressions.push({startIndex, endIndex, expressionText, direction});

    // Start looking for the next expression after the end of this one.
    openers.lastIndex = endIndex + 2;
  }
  return expressions;
}

function findNewlineIndexes(str: string) {
  const indexes = [];
  let prev;
  let index = str.indexOf('\n');
  while (index !== -1) {
    indexes.push(index);
    prev = index;
    index = str.indexOf('\n', prev + 1);
  }
  return indexes;
}

function indexesToSourceRange(
    startIndex: number,
    endIndex: number,
    filename: string,
    newlineIndexes: number[]): SourceRange {
  let startLineNumLinesIntoText = 0;
  let startOfLineIndex = 0;
  let endLineNumLinesIntoText = 0;
  let endOfLineIndex = 0;
  for (const index of newlineIndexes) {
    if (index < startIndex) {
      startLineNumLinesIntoText++;
      startOfLineIndex = index + 1;
    }
    if (index < endIndex) {
      endLineNumLinesIntoText++;
      endOfLineIndex = index + 1;
    } else {
      // Nothing more interesting to do.
      break;
    }
  }
  return {
    file: filename,
    start: {
      line: startLineNumLinesIntoText,
      column: startIndex - startOfLineIndex
    },
    end: {line: endLineNumLinesIntoText, column: endIndex - endOfLineIndex}
  };
}

function parseExpression(content: string, expressionSourceRange: SourceRange) {
  const expressionOffset = {
    line: expressionSourceRange.start.line,
    col: expressionSourceRange.start.column
  };
  const parseResult = parseJs(
      content,
      expressionSourceRange.file,
      expressionOffset,
      'polymer-expression-parse-error');
  if (parseResult.type === 'success') {
    return parseResult;
  }
  // The polymer databinding expression language allows for foo.0 and foo.*
  // formats when accessing sub properties. These aren't valid JS, but we don't
  // want to warn for them either. So just return undefined for now.
  if (/\.(\*|\d+)/.test(content)) {
    return undefined;
  }
  return parseResult;
}

export function parseExpressionInJsStringLiteral(
    document: JavaScriptDocument, stringLiteral: estree.Node) {
  const warnings: Warning[] = [];
  const result = {
    databinding: undefined as undefined | JavascriptDatabindingExpression,
    warnings
  };
  const sourceRangeForLiteral = document.sourceRangeForNode(stringLiteral)!;

  if (stringLiteral.type !== 'Literal') {
    // Should we warn here? It's potentially valid, just unanalyzable. Maybe
    // just an info that someone could escalate to a warning/error?
    warnings.push({
      code: 'unanalyzable-polymer-expression',
      message: `Can only analyze databinding expressions in string literals.`,
      severity: Severity.INFO,
      sourceRange: sourceRangeForLiteral,
    });
    return result;
  }
  const expressionText = stringLiteral.value;
  if (typeof expressionText !== 'string') {
    warnings.push({
      code: 'invalid-polymer-expression',
      message: `Expected a string, got a ${typeof expressionText}.`,
      sourceRange: sourceRangeForLiteral,
      severity: Severity.WARNING
    });
    return result;
  }
  const sourceRange: SourceRange = {
    file: sourceRangeForLiteral.file,
    start: {
      column: sourceRangeForLiteral.start.column + 1,
      line: sourceRangeForLiteral.start.line
    },
    end: {
      column: sourceRangeForLiteral.end.column - 1,
      line: sourceRangeForLiteral.end.line
    }
  };
  const parsed = parseExpression(expressionText, sourceRange);
  if (parsed && parsed.type === 'failure') {
    warnings.push(parsed.warning);
  } else if (parsed && parsed.type === 'success') {
    result.databinding = new JavascriptDatabindingExpression(
        stringLiteral, sourceRange, expressionText, parsed.program);
  }
  return result;
}
