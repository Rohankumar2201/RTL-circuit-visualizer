module loopy(input [3:0] a, output reg [3:0] y);
integer i;
always_comb begin
    for (i = 0; i < 4; i = i + 1) y[i] = a[3 - i];
end
endmodule
