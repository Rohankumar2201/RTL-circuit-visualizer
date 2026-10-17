import type { AnalysisStatus } from '../parser/diagnostics';

export interface Example {
  id: string;
  title: string;
  description: string;
  source: string;
  /** Expectations checked automatically against the analyzed top module (tests/integration/examples.test.ts). */
  expect: { top: string; inputs: number; outputs: number; registers: number; muxes?: number; instances?: number; statuses: AnalysisStatus[] };
}

const ex = (e: Example): Example => e;

export const EXAMPLES: Example[] = [
  ex({
    id: 'and', title: 'AND gate', description: 'One continuous assign becomes a single AND gate.',
    source: `module and_gate(
    input  a,
    input  b,
    output y
);

assign y = a & b;

endmodule`,
    expect: { top: 'and_gate', inputs: 2, outputs: 1, registers: 0, statuses: ['complete'] },
  }),
  ex({
    id: 'or', title: 'OR gate', description: 'Bitwise OR of two inputs.',
    source: `module or_gate(
    input  a,
    input  b,
    output y
);

assign y = a | b;

endmodule`,
    expect: { top: 'or_gate', inputs: 2, outputs: 1, registers: 0, statuses: ['complete'] },
  }),
  ex({
    id: 'xor', title: 'XOR gate', description: 'Bitwise XOR of two inputs.',
    source: `module xor_gate(
    input  a,
    input  b,
    output y
);

assign y = a ^ b;

endmodule`,
    expect: { top: 'xor_gate', inputs: 2, outputs: 1, registers: 0, statuses: ['complete'] },
  }),
  ex({
    id: 'half-adder', title: 'Half adder', description: 'Sum is an XOR, carry is an AND of the same inputs (fan-out of 2).',
    source: `module half_adder(
    input  a,
    input  b,
    output sum,
    output carry
);

assign sum   = a ^ b;
assign carry = a & b;

endmodule`,
    expect: { top: 'half_adder', inputs: 2, outputs: 2, registers: 0, statuses: ['complete'] },
  }),
  ex({
    id: 'full-adder', title: 'Full adder', description: 'Two half-adder stages written with a shared intermediate wire.',
    source: `module full_adder(
    input  a,
    input  b,
    input  cin,
    output sum,
    output cout
);

wire axb;
assign axb  = a ^ b;
assign sum  = axb ^ cin;
assign cout = (a & b) | (axb & cin);

endmodule`,
    expect: { top: 'full_adder', inputs: 3, outputs: 2, registers: 0, statuses: ['complete'] },
  }),
  ex({
    id: 'mux2', title: '2:1 mux', description: 'The ?: operator infers a 2:1 multiplexer on an 8-bit bus.',
    source: `module mux2(
    input  [7:0] a,
    input  [7:0] b,
    input        sel,
    output [7:0] y
);

assign y = sel ? a : b;

endmodule`,
    expect: { top: 'mux2', inputs: 3, outputs: 1, registers: 0, muxes: 1, statuses: ['complete'] },
  }),
  ex({
    id: 'mux4', title: '4:1 mux', description: 'A fully specified case statement on a 2-bit select infers one 4:1 mux.',
    source: `module mux4(
    input  [3:0] d0,
    input  [3:0] d1,
    input  [3:0] d2,
    input  [3:0] d3,
    input  [1:0] sel,
    output reg [3:0] y
);

always_comb begin
    case (sel)
        2'b00: y = d0;
        2'b01: y = d1;
        2'b10: y = d2;
        2'b11: y = d3;
    endcase
end

endmodule`,
    expect: { top: 'mux4', inputs: 5, outputs: 1, registers: 0, muxes: 1, statuses: ['complete'] },
  }),
  ex({
    id: 'decoder', title: '2:4 decoder', description: 'Default assignment plus an enable and a case statement; every path assigns y, so no latch.',
    source: `module decoder2to4(
    input  [1:0] sel,
    input        en,
    output reg [3:0] y
);

always_comb begin
    y = 4'b0000;
    if (en) begin
        case (sel)
            2'd0: y = 4'b0001;
            2'd1: y = 4'b0010;
            2'd2: y = 4'b0100;
            2'd3: y = 4'b1000;
        endcase
    end
end

endmodule`,
    expect: { top: 'decoder2to4', inputs: 2, outputs: 1, registers: 0, muxes: 2, statuses: ['complete'] },
  }),
  ex({
    id: 'encoder', title: 'Priority encoder', description: 'An if / else-if chain becomes a chain of 2:1 muxes with a valid flag.',
    source: `module priority_encoder(
    input  [3:0] req,
    output reg [1:0] code,
    output reg       valid
);

always_comb begin
    valid = 1'b1;
    if (req[3])      code = 2'd3;
    else if (req[2]) code = 2'd2;
    else if (req[1]) code = 2'd1;
    else if (req[0]) code = 2'd0;
    else begin
        code  = 2'd0;
        valid = 1'b0;
    end
end

endmodule`,
    expect: { top: 'priority_encoder', inputs: 1, outputs: 2, registers: 0, muxes: 8, statuses: ['complete'] },
  }),
  ex({
    id: 'comparator', title: 'Comparator', description: 'Three comparators share the same 4-bit inputs.',
    source: `module comparator(
    input  [3:0] a,
    input  [3:0] b,
    output       eq,
    output       lt,
    output       gt
);

assign eq = (a == b);
assign lt = (a < b);
assign gt = (a > b);

endmodule`,
    expect: { top: 'comparator', inputs: 2, outputs: 3, registers: 0, statuses: ['complete'] },
  }),
  ex({
    id: 'alu', title: 'Arithmetic unit', description: 'Adder, subtractor, AND and OR selected by a 2-bit opcode; a zero flag reads the result.',
    source: `module arith_unit(
    input  [7:0] a,
    input  [7:0] b,
    input  [1:0] op,
    output reg [7:0] y,
    output       zero
);

always_comb begin
    case (op)
        2'b00: y = a + b;
        2'b01: y = a - b;
        2'b10: y = a & b;
        2'b11: y = a | b;
    endcase
end

assign zero = (y == 8'd0);

endmodule`,
    expect: { top: 'arith_unit', inputs: 3, outputs: 2, registers: 0, muxes: 1, statuses: ['complete'] },
  }),
  ex({
    id: 'counter', title: 'Counter', description: 'A 4-bit counter with an asynchronous active-high reset.',
    source: `module counter(
    input clk,
    input reset,
    output reg [3:0] count
);

always_ff @(posedge clk or posedge reset) begin
    if (reset) count <= 4'b0000;
    else       count <= count + 1;
end

endmodule`,
    expect: { top: 'counter', inputs: 2, outputs: 1, registers: 1, statuses: ['complete'] },
  }),
  ex({
    id: 'shift', title: 'Shift register', description: 'A 4-bit shift register built with a concatenation of a part-select and the serial input.',
    source: `module shift_reg(
    input  clk,
    input  din,
    output reg [3:0] q
);

always_ff @(posedge clk) begin
    q <= {q[2:0], din};
end

endmodule`,
    expect: { top: 'shift_reg', inputs: 2, outputs: 1, registers: 1, statuses: ['complete'] },
  }),
  ex({
    id: 'reg-sync', title: 'Sync reset register', description: 'The reset is only checked on the clock edge (recognized from the name rst).',
    source: `module reg_sync_reset(
    input  clk,
    input  rst,
    input  [7:0] d,
    output reg [7:0] q
);

always_ff @(posedge clk) begin
    if (rst) q <= 8'h00;
    else     q <= d;
end

endmodule`,
    expect: { top: 'reg_sync_reset', inputs: 3, outputs: 1, registers: 1, statuses: ['complete'] },
  }),
  ex({
    id: 'reg-async', title: 'Async reset register', description: 'Active-low asynchronous reset, derived from the negedge in the sensitivity list.',
    source: `module reg_async_reset(
    input  clk,
    input  rst_n,
    input  [7:0] d,
    output reg [7:0] q
);

always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) q <= 8'h00;
    else        q <= d;
end

endmodule`,
    expect: { top: 'reg_async_reset', inputs: 3, outputs: 1, registers: 1, statuses: ['complete'] },
  }),
  ex({
    id: 'reg-enable', title: 'Enabled register', description: 'An if without else holds the value, which becomes the flip-flop enable pin.',
    source: `module reg_enable(
    input  clk,
    input  en,
    input  [7:0] d,
    output reg [7:0] q
);

always_ff @(posedge clk) begin
    if (en) q <= d;
end

endmodule`,
    expect: { top: 'reg_enable', inputs: 3, outputs: 1, registers: 1, statuses: ['complete'] },
  }),
  ex({
    id: 'fsm', title: 'Simple FSM', description: 'Three-state machine: next-state logic as a case, state register with async reset.',
    source: `module traffic_fsm(
    input  clk,
    input  rst_n,
    input  start,
    output busy,
    output done
);

localparam IDLE = 2'd0, RUN = 2'd1, DONE = 2'd2;

reg [1:0] state, next_state;

always_comb begin
    next_state = state;
    case (state)
        IDLE:    if (start) next_state = RUN;
        RUN:     next_state = DONE;
        DONE:    next_state = IDLE;
        default: next_state = IDLE;
    endcase
end

always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) state <= IDLE;
    else        state <= next_state;
end

assign busy = (state == RUN);
assign done = (state == DONE);

endmodule`,
    expect: { top: 'traffic_fsm', inputs: 3, outputs: 2, registers: 1, muxes: 2, statuses: ['complete'] },
  }),
  ex({
    id: 'hierarchy', title: 'Multi-module design', description: 'A full adder built from two half_adder instances; open a module from the hierarchy panel.',
    source: `module half_adder(
    input  a,
    input  b,
    output s,
    output c
);

assign s = a ^ b;
assign c = a & b;

endmodule

module full_adder_top(
    input  a,
    input  b,
    input  cin,
    output sum,
    output cout
);

wire s1, c1, c2;

half_adder u_ha0 (.a(a),  .b(b),   .s(s1),  .c(c1));
half_adder u_ha1 (.a(s1), .b(cin), .s(sum), .c(c2));

assign cout = c1 | c2;

endmodule`,
    expect: { top: 'full_adder_top', inputs: 3, outputs: 2, registers: 0, instances: 2, statuses: ['complete'] },
  }),
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];
