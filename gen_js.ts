/// <reference path="./defs.d.ts" />

import ir = require('./ir');
import { IndentWriter, IndentedString, NameAlloc, classNameOf, trace } from './utils';

class Generator {
	private binopRaw(e:ir.BinOpExpression) {
		let func:string = null;
		let out = IndentedString.EMPTY;
        switch (e.op) {
            case '**': func = 'Math.pow'; break;
			case '...': func = '$ExpLang.range'; break;
			case '<=>': func = '$ExpLang.icomp'; break;
            default:
				if ([
					'=', '+=', '-=',
					'==', '!=', '<', '>', '<=', '>=', 
					'+', '-', '*', '/', '%',
					'|', '&',
				].indexOf(e.op) >= 0) {
					func = null;
				} else {
					throw new Error(`Unknown operator ${e.op}`);
				}
        }							
        if (func) out = out.with(`${func}(`);
        out = out.with(this.expr(e.left));
        out = out.with(func ? `, ` : ` ${e.op} `);
        out = out.with(this.expr(e.right));
        if (func) out = out.with(`)`);
		return out;
	}
	
	protected expr(e:ir.Expression):IndentedString {
		if (e == null) return IndentedString.EMPTY;
		var out = IndentedString.EMPTY;
		
		if (e instanceof ir.BinOpExpression) {
            let type = e.type;
			if (type == ir.Types.Int) return out.with('((').with(this.binopRaw(e)).with(')|0)');
			if (type == ir.Types.Bool) return out.with('!!(').with(this.binopRaw(e)).with(')');
			if (ir.Types.isIterable(type)) return this.binopRaw(e);
			if (type instanceof ir.ClassType) return this.binopRaw(e);
            throw new Error(`gen_js.BinOpNode.Unhandled type ${type} ${e.op}`);
        }
		if (e instanceof ir.AssignExpression) {
			return out.with(this.expr(e.lvalue)).with(' = ').with(this.expr(e.expr));
		}
		if (e instanceof ir.ThisExpression) return IndentedString.EMPTY.with('this');
		if (e instanceof ir.MemberAccess) return IndentedString.EMPTY.with(this.expr(e.left)).with('.').with(e.member.name);
		if (e instanceof ir.ArrayAccess) return IndentedString.EMPTY.with(this.expr(e.left)).with('[').with(this.expr(e.index)).with(']');
		if (e instanceof ir.UnknownExpression) return IndentedString.EMPTY.with(`$unknown$`);
		if (e instanceof ir.Immediate) {
			switch (e.type) {
				case ir.Types.Int: return IndentedString.EMPTY.with(`${e.value}`);
				case ir.Types.String: return IndentedString.EMPTY.with(JSON.stringify(e.value));
				default: throw new Error(`gen_js :: Unhandled Immediate Type ${e.type}`);
			}
		}
		if (e instanceof ir.MemberExpression) return IndentedString.EMPTY.with(`this.${e.member.name}`);
		if (e instanceof ir.ArgumentExpression) return IndentedString.EMPTY.with(`${e.arg.name}`);
		if (e instanceof ir.LocalExpression) return IndentedString.EMPTY.with(`${e.local.allocName}`);
		if (e instanceof ir.UnopPost) return IndentedString.EMPTY.with(this.expr(e.left)).with(e.op);
		if (e instanceof ir.CallExpression) return out.with(this.expr(e.left)).with(this._callArgs(e.args));
		if (e instanceof ir.NewExpression) return out.with('new ').with(e.clazz.fqname).with(this._callArgs(e.args));
		if (e instanceof ir.IntrinsicCall) {
			switch (e.intrinsic) {
				case ir.INTRINSIC_JS_RAW:
					let arg = e.args[0];
					if (arg instanceof ir.Immediate) {
						return out.with(arg.value);
					}				
					break;
			}
			throw new Error(`gen_js : Unknown or unhandled intrinsic ${e.intrinsic}`);
		}
		
		throw new Error(`gen_js:Unhandled generate expression ${e}`);
	}
	
	private _callArgs(args:ir.Expression[]) {
		let out = IndentedString.EMPTY;
		out = out.with('(');
		for (var n = 0; n < args.length; n++) {
			if (n != 0) out = out.with(', ');
			out = out.with(this.expr(args[n]));
		}
		out = out.with(')');
		return out;
	}
	
	private hasConditionalName(name:string) {
		return ['js'].indexOf(name) >= 0;
	}
	
	protected stm(s:ir.Statement):IndentedString {
		if (s == null) return IndentedString.EMPTY;
		
		if (s instanceof ir.Statements) {
			let out = IndentedString.EMPTY;
			for (let c of s.nodes) out = out.with(this.stm(c));
			return out;
		}		
		if (s instanceof ir.ReturnNode) {
			return IndentedString.EMPTY.with('return ').with(this.expr(s.optValue)).with(';\n');
		}
		if (s instanceof ir.ExpressionStm) {
			return IndentedString.EMPTY.with(this.expr(s.expression)).with(';\n');
		}
		if (s instanceof ir.IfNode) {
			let out = IndentedString.EMPTY;
			out = out.with('if (').with(this.expr(s.expr)).with(')');
			out = out.with('{').with(this.stm(s.trueStm)).with('}');
			out = out.with('else {').with(this.stm(s.falseStm)).with('}');
			return out;
		}
		// @TODO: This should be outside each generator
		if (s instanceof ir.StaticIfNode) {
			let out = IndentedString.EMPTY;
			if (this.hasConditionalName(s.id)) {
				return out.with(this.stm(s.trueStm));
			} else {
				return out.with(this.stm(s.falseStm));
			}
		}
		if (s instanceof ir.StaticFailNode) {
			throw new Error(`Failed at ${s.psi.file}:${s.psi.range} : ${s.msg}`);
		}
		if (s instanceof ir.FastForNode) {
			let localName = s.local.allocName;
			return IndentedString.EMPTY
				.with(`for (${localName} = ${s.min}; ${localName} < ${s.max}; ${localName}++) {`)
				.with(this.stm(s.body))
				.with('}')
			;
		}
		if (s instanceof ir.Fast2ForNode) {
			let localName = s.local.allocName;
			let l = s.min, r = s.max;
			let MIN = this.method.names.alloc('__min');
			let MAX = this.method.names.alloc('__max');
			let out = IndentedString.EMPTY;
			out = out.with(`var ${MIN} = `).with(this.expr(l)).with(';');
			out = out.with(`var ${MAX} = `).with(this.expr(r)).with(';');
			out = out.with(`for (${localName} = ${MIN}; ${localName} < ${MAX}; ${localName}++) {`);
			out = out.with(this.stm(s.body));
			out = out.with('}');
			return out;
		}
		if (s instanceof ir.ForNode) {
			let out = IndentedString.EMPTY;
			let expr = s.expr;
			let localName = s.local.allocName;
			//console.info(classNameOf(s.expr));
			let TEMPNAME = this.method.names.alloc('__temp');
			out = out.with(`var ${TEMPNAME} = `).with(this.expr(s.expr)).with('.iterator();');
			out = out.with(`while (${TEMPNAME}.hasMore()) {`);
			out = out.with(localName).with(' = ').with(`${TEMPNAME}.next();`);
			out = out.with(this.stm(s.body));
			out = out.with('}');
			return out;
		}
		if (s instanceof ir.WhileNode) {
			let out = IndentedString.EMPTY;
			out = out.with('while (').with(this.expr(s.expr)).with(')');
			out = out.with('{').with(this.stm(s.body)).with('}');
			return out;
		}
		throw new Error(`gen_js: Unhandled generate statement ${s}`);
	}

	private method:ir.IrMethod;
    protected generateMethod(method:ir.IrMethod):IndentedString {
		this.method = method;
		let name = method.name;
        let className = method.containingClass.name;
		let out = IndentedString.EMPTY;
		let params = method.params.getParams();
		if (method.modifiers & ir.IrModifiers.STATIC) {
			out = out.with(`${className}.${name} = function(`);
		} else {
			out = out.with(`${className}.prototype.${name} = function(`);
		}
		out = out.with(params.map(p => p.name).join(', '));
		out = out.with(`) {\n`);
		out = out.indent(() => {
			let out = IndentedString.EMPTY;
			for (let local of method.locals) {
				out = out.with('var ' + local.allocName).with(' = ').with(this.getInit(null, local.type)).with(';\n');
			}
			out = out.with(this.stm(method.body));
			return out;
		});
		out = out.with(`};\n`);
		return out;
    }
	
	getInit(init:ir.Expression, type:ir.Type) {
		if (init != null) {
			return this.expr(init)
		} else {
			if (type == ir.Types.Int) {
				return IndentedString.EMPTY.with('0');
			} else if (ir.Types.isIterable(type) || type instanceof ir.ClassType) {
				return IndentedString.EMPTY.with('null');
			} else {
				throw new Error(`gen_js.getInit: Unhandled type ${type}`);
			}
		}
	}
	
	protected generateClass(clazz:ir.IrClass):IndentedString {
        const name = clazz.name;
		let out = IndentedString.EMPTY;
		out = out.with(`var ${name} = (function () {\n`);
		out = out.indent(() => {
			let out = IndentedString.EMPTY;
			out = out.with(`function ${name}() {\n`);
			//trace(clazz.fields.length);
            for (const field of clazz.fields) {
                out = out.with(`this.${field.name} = `).with(this.getInit(field.init, field.type)).with(';');
            }
			out = out.with(`}\n`);
            for (const method of clazz.methods) {
                out = out.with(this.generateMethod(method));
            }
            out = out.with(`return ${name};\n`);
			return out;
		});
		out = out.with(`})();`);
		return out;
	}

	generateModule(module:ir.IrModule) {
		let out = IndentedString.EMPTY;
		for (const clazz of module.classes) {
			out = out.with(this.generateClass(clazz));
		}
		return out;
	}
}

export function generate(module:ir.IrModule):string {
	return new Generator().generateModule(module).toString();
}

export function generateRuntime():string {
	return `
		$ExpLang = {};
		$ExpLang.RangeIterator = (function() {
			function RangeIterator(min, max) { this.current = min; this.max = max; }
			RangeIterator.prototype.hasMore = function() { return this.current < this.max; };
			RangeIterator.prototype.next = function() { return this.current++; };
			return RangeIterator;
		})();
		$ExpLang.Range = (function() {
			function Range(min, max) { this.min = min; this.max = max; }
			Range.prototype.iterator = function() { return new ($ExpLang.RangeIterator)(this.min, this.max); }
			return Range;
		})();
		$ExpLang.range = function(min, max) { return new ($ExpLang.Range)(min, max); }
		$ExpLang.icomp = function(a, b) { if (a < b) return -1; else if (a > b) return +1; else return 0; }
	`;
}
